import { createContext } from "react";

export const OmpUiActionContext = createContext<((message: string) => Promise<boolean>) | null>(null);

/** A capability supplied only to writable assistant text in its owning session. */
export interface OmpUiActionScope {
  sessionId: string;
  send: (message: string) => Promise<boolean>;
}

export function formatOmpUiActionMessage(message: string): string {
  // Never let generated action text enter the ! / slash-command dispatch paths.
  return `OMP UI — действие пользователя:\n${message}`;
}

export function createOmpUiActionHandler(options: {
  canSend: () => boolean;
  isBusy: () => boolean;
  send: (message: string) => Promise<boolean>;
  followUp: (message: string) => Promise<boolean>;
}): (message: string) => Promise<boolean> {
  let pending = false;
  return async (message) => {
    if (!options.canSend()) {
      throw new Error("Действие недоступно: сессия изменилась, загружается или соединение потеряно.");
    }
    if (pending) return false;
    pending = true;
    try {
      const prompt = formatOmpUiActionMessage(message);
      return await (options.isBusy() ? options.followUp(prompt) : options.send(prompt));
    } finally {
      pending = false;
    }
  };
}
