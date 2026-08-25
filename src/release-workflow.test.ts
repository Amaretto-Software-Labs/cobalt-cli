import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("release workflow", () => {
  it("binds package and publish jobs to the resolved protected environment", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain(
      "environment: ${{ steps.release.outputs.environment }}",
    );
    expect(workflow).toContain('echo "environment=$channel"');
    expect(workflow.match(/>> "\$GITHUB_OUTPUT"/g)).toHaveLength(1);
    expect(
      workflow.match(
        /environment: \$\{\{ needs\.resolve\.outputs\.environment \}\}/g,
      ),
    ).toHaveLength(2);
  });
});
