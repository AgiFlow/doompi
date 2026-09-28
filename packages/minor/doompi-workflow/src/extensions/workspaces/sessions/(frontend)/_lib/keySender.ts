/**
 * Sends keystrokes to a run one request at a time, in the order they were typed.
 *
 * One request per keystroke, all in flight together, can land out of order: a
 * quickly typed word reaches the pane as an anagram. Keys typed while a request
 * is in flight are batched into the next one. `send` answers false when the run
 * refused the keys; whatever is still queued is then dropped rather than sent
 * after a refusal.
 */
export function createKeySender(send: (data: string) => Promise<boolean>): (data: string) => void {
  let pending = '';
  let sending = false;

  const drain = async (): Promise<void> => {
    sending = true;
    while (pending !== '') {
      const batch = pending;
      pending = '';
      if (!(await send(batch))) pending = '';
    }
    sending = false;
  };

  return (data: string): void => {
    pending += data;
    if (!sending) void drain();
  };
}
