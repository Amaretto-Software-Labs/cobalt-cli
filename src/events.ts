import type { CobaltApiClient, TaskEvent } from "./api.js";
import { CliError, ExitCode } from "./errors.js";

export async function readAvailableEvents(
  api: Pick<CobaltApiClient, "listEvents">,
  taskId: string,
  afterSequence: number,
  emit: (event: TaskEvent) => void,
  delay: (milliseconds: number) => Promise<void> = async (milliseconds) =>
    await new Promise((resolve) => setTimeout(resolve, milliseconds)),
  signal?: AbortSignal,
): Promise<number> {
  let page;
  do {
    page = await readContiguousPage(api, taskId, afterSequence, delay, signal);
    const events = uniqueVisible(page.items, afterSequence);
    for (const event of events) {
      emit(event);
      afterSequence = event.sequence;
    }
    if (page.hasMore && events.length === 0)
      throw new CliError(
        "The External API returned an event page without advancing its sequence.",
        ExitCode.unavailable,
      );
  } while (page.hasMore);
  return afterSequence;
}

async function readContiguousPage(
  api: Pick<CobaltApiClient, "listEvents">,
  taskId: string,
  afterSequence: number,
  delay: (milliseconds: number) => Promise<void>,
  signal?: AbortSignal,
) {
  let page = await api.listEvents(taskId, afterSequence, 100, signal);
  for (let attempt = 1; attempt <= 3; attempt++) {
    let expected = afterSequence;
    const contiguous = uniqueVisible(page.items, afterSequence).every(
      (event) => {
        if (event.sequence !== expected + 1) return false;
        expected = event.sequence;
        return true;
      },
    );
    if (contiguous || attempt === 3) return page;
    await delay(100);
    page = await api.listEvents(taskId, afterSequence, 100, signal);
  }
  return page;
}

function uniqueVisible(
  events: readonly TaskEvent[],
  afterSequence: number,
): TaskEvent[] {
  const seen = new Set<number>();
  return events
    .filter((event) => event.sequence > afterSequence)
    .sort((left, right) => left.sequence - right.sequence)
    .filter(
      (event) => !seen.has(event.sequence) && Boolean(seen.add(event.sequence)),
    );
}
