import { test, expect } from "playwright/test";

const repository = process.env.QA_REPO_PATH;
const worktrees = process.env.QA_WORKTREES_DIR;

test("QA-UI-001 user can configure a project and create a BUILD", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.getByText("选择项目", { exact: true })).toBeVisible();
  await page.getByText("选择项目", { exact: true }).click();
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByPlaceholder("项目名称").fill("Browser E2E Project");
  await page.getByPlaceholder("仓库路径 repoPath").fill(repository);
  await page.getByPlaceholder("worktree 目录 worktreesDir").fill(worktrees);
  await page.getByPlaceholder("基线分支（可留空）").fill("main");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(
    page.getByText("Browser E2E Project", { exact: true }),
  ).toBeVisible();

  await page.getByTitle("新建工作").click();
  const titleInput = page.getByPlaceholder("BUILD 工作标题，回车创建");
  await titleInput.fill("Browser-created BUILD");
  await titleInput.press("Enter");

  await expect(page).toHaveURL(/\?work=WORK-/);
  await expect(page.getByTitle("展开侧边栏")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Browser-created BUILD" }),
  ).toBeVisible();
  await expect(page.getByText("和 AI 一起把需求说清楚")).toBeVisible();
  await expect(page.getByText("需求理解", { exact: true })).toBeVisible();
  await expect(page.getByText("开发任务", { exact: true })).toBeVisible();

  const workId = new URL(page.url()).searchParams.get("work");
  await expect
    .poll(async () => {
      const response = await request.get(`/api/v5/works/${workId}`);
      const detail = await response.json();
      return detail.activities.find((activity) => activity.type === "alignment")
        .status;
    })
    .not.toBe("idle");
});

test("QA-UI-002 application exposes BUILD as the only lifecycle", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("BUILD", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Legacy", { exact: true })).toHaveCount(0);
  await expect(page.getByText("旧需求", { exact: true })).toHaveCount(0);
  await expect(page.getByText("改为创建旧版需求", { exact: true })).toHaveCount(
    0,
  );
});

test("QA-UI-003 application shell loads without failed static resources", async ({
  page,
}) => {
  const failedResources = [];
  page.on("response", (response) => {
    if (response.status() >= 400)
      failedResources.push(`${response.status()} ${response.url()}`);
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  expect(failedResources).toEqual([]);
});
