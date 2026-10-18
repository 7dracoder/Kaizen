"use client";

// The board every tab is looking at. Picking a build on any tab sets it, and the nav links carry it, so Board,
// Harness, Graph and Memory all open on the same build.
import { useSyncExternalStore } from "react";

const KEY = "kaizen:current-board";
const EVENT = "kaizen:current-board";

export function readCurrentBoard(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(KEY);
}

export function setCurrentBoard(id: string | null | undefined) {
  if (typeof window === "undefined" || !id || id === readCurrentBoard()) return;
  window.localStorage.setItem(KEY, id);
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useCurrentBoard(): string | null {
  return useSyncExternalStore(subscribe, readCurrentBoard, () => null);
}
