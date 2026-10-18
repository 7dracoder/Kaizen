// Auth.js adapter on FalkorDB: accounts and sessions live in the shared graph as
//   (:User)-[:HAS_ACCOUNT]->(:Account), (:User)-[:HAS_SESSION]->(:Session), (:VerificationToken)
// The adapter only touches these four labels; it never reads or writes design state.
import type { Adapter, AdapterAccount, AdapterSession, AdapterUser, VerificationToken } from "next-auth/adapters";
import { col, forgetUser, newId } from "@kaizen/graph";

type Rec = Record<string, unknown>;
const toDate = (v: unknown): Date | null => (v == null ? null : new Date(v as string));

const user = (d: Rec | null): AdapterUser | null =>
  d ? ({ ...d, id: d._id, emailVerified: toDate(d.emailVerified) } as unknown as AdapterUser) : null;

const session = (d: Rec | null): AdapterSession | null =>
  d ? ({ sessionToken: d.sessionToken, userId: d.userId, expires: new Date(d.expires as string) } as AdapterSession) : null;

/** Auth.js passes `id`; the graph keys records by `_id`. */
const strip = (o: object): Rec => {
  const rest: Rec = { ...(o as Rec) };
  delete rest.id;
  return rest;
};

export function FalkorDBAdapter(): Adapter {
  return {
    async createUser(data) {
      const _id = newId();
      await col.users.insertOne({ ...strip(data), _id });
      return user(await col.users.findOne({ _id }))!;
    },
    async getUser(id) {
      return user(await col.users.findOne({ _id: id }));
    },
    async getUserByEmail(email) {
      return user(await col.users.findOne({ email }));
    },
    async getUserByAccount({ provider, providerAccountId }) {
      const account = await col.accounts.findOne({ provider, providerAccountId });
      if (!account) return null;
      return user(await col.users.findOne({ _id: account.userId }));
    },
    async updateUser(data) {
      const { id, ...rest } = data;
      await col.users.updateOne({ _id: id }, { $set: rest as never });
      return user(await col.users.findOne({ _id: id }))!;
    },
    async deleteUser(id) {
      const existing = await col.users.findOne({ _id: id });
      await Promise.all([
        col.accounts.deleteMany({ userId: id }),
        col.sessions.deleteMany({ userId: id }),
        col.users.deleteMany({ _id: id }),
      ]);
      await forgetUser(id); // the user's own memory graph goes with the account
      return user(existing);
    },
    async linkAccount(account) {
      await col.accounts.insertOne({ ...(account as Record<string, unknown>), _id: newId() });
      return account as AdapterAccount;
    },
    async unlinkAccount({ provider, providerAccountId }) {
      const existing = await col.accounts.findOne({ provider, providerAccountId });
      await col.accounts.deleteMany({ provider, providerAccountId });
      return (existing as unknown as AdapterAccount) ?? undefined;
    },
    async createSession(data) {
      await col.sessions.insertOne({ ...data, _id: newId() });
      return data;
    },
    async getSessionAndUser(sessionToken) {
      const s = await col.sessions.findOne({ sessionToken });
      if (!s) return null;
      if (new Date(s.expires as string).getTime() < Date.now()) {
        await col.sessions.deleteMany({ sessionToken }); // expired: clean up on read
        return null;
      }
      const u = await col.users.findOne({ _id: s.userId });
      if (!u) return null;
      return { session: session(s)!, user: user(u)! };
    },
    async updateSession(data) {
      const { sessionToken, ...rest } = data;
      const r = await col.sessions.findOneAndUpdate({ sessionToken }, { $set: rest as never }, { returnDocument: "after" });
      return session(r);
    },
    async deleteSession(sessionToken) {
      const s = await col.sessions.findOne({ sessionToken });
      await col.sessions.deleteMany({ sessionToken });
      return session(s);
    },
    async createVerificationToken(data) {
      await col.verificationTokens.insertOne({ ...data, _id: newId() });
      return data;
    },
    async useVerificationToken({ identifier, token }) {
      const t = await col.verificationTokens.findOne({ identifier, token });
      if (!t) return null;
      await col.verificationTokens.deleteMany({ identifier, token }); // single use
      return { identifier: t.identifier, token: t.token, expires: new Date(t.expires as string) } as VerificationToken;
    },
  };
}
