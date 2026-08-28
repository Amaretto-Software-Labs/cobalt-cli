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

    const publishJob = workflow.slice(workflow.indexOf("  publish:\n"));
    expect(publishJob).toContain("registry-url: https://registry.npmjs.org");
    expect(publishJob).toContain("package-manager-cache: false");
    expect(publishJob).not.toContain("npm install --global npm@");
    expect(publishJob).not.toContain("--provenance");
    expect(publishJob).toContain(
      "- name: Publish with npm trusted publishing\n        if: ${{ vars.NPM_TRUSTED_PUBLISHING_ENABLED == 'true' }}",
    );
    expect(publishJob).toContain(
      "- name: Report disabled publishing\n        if: ${{ vars.NPM_TRUSTED_PUBLISHING_ENABLED != 'true' }}",
    );
  });
});
