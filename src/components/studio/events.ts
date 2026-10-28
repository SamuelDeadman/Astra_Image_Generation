"use client";

export const sessionChangedEvent = "astraflow:session-changed";
export const studioDataChangedEvent = "astraflow:studio-data-changed";

export function announceSessionChanged() {
  window.dispatchEvent(new Event(sessionChangedEvent));
  window.dispatchEvent(new Event(studioDataChangedEvent));
}

export function announceStudioDataChanged() {
  window.dispatchEvent(new Event(studioDataChangedEvent));
}
