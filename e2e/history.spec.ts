import { test, expect } from "./fixtures";
import { seedMemo, purge, uniq } from "./helpers";

// These exercise the server-side session-snapshot history end-to-end. The 1h
// production thresholds are overridden to 1s in .dev.vars (HISTORY_GAP_MS), so a
// short wait is enough to cross a "session boundary" here.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe("session-snapshot history", () => {
  test("records the prior state once a new session begins after an idle gap", async ({
    request,
  }) => {
    const title = uniq("Hist");
    const id = await seedMemo(request, `# ${title}\n\nv1`); // first write: nothing to preserve
    try {
      expect(await (await request.get(`/api/memos/${id}/versions`)).json()).toHaveLength(0);

      await wait(1300); // exceed the 1s dev gap → next edit opens a new session
      await request.put(`/api/memos/${id}`, { data: { content: `# ${title}\n\nv2` } });

      const versions = (await (await request.get(`/api/memos/${id}/versions`)).json()) as Array<{
        id: number;
        title: string;
      }>;
      expect(versions).toHaveLength(1);
      expect(versions[0].title).toBe(title);

      // the snapshot holds the previous session's final content
      const snap = (await (
        await request.get(`/api/memos/${id}/versions/${versions[0].id}`)
      ).json()) as { content: string };
      expect(snap.content).toBe(`# ${title}\n\nv1`);
    } finally {
      await purge(request, id);
    }
  });

  test("does not record snapshots for rapid edits within one session", async ({ request }) => {
    const id = await seedMemo(request, `# ${uniq("Sess")}\n\nv1`);
    try {
      // edit again immediately — well inside the gap window
      await request.put(`/api/memos/${id}`, { data: { content: "edited in-session" } });
      expect(await (await request.get(`/api/memos/${id}/versions`)).json()).toHaveLength(0);
    } finally {
      await purge(request, id);
    }
  });

  test("purge removes a memo's version history", async ({ request }) => {
    const id = await seedMemo(request, `# ${uniq("Purge")}\n\nv1`);
    await wait(1300);
    await request.put(`/api/memos/${id}`, { data: { content: "v2" } });
    expect(await (await request.get(`/api/memos/${id}/versions`)).json()).toHaveLength(1);

    await purge(request, id);
    expect(await (await request.get(`/api/memos/${id}/versions`)).json()).toHaveLength(0);
  });
});
