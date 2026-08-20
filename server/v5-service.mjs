import { newWork } from "./model-v5.mjs";
import { createBuildActivities } from "./build-flow.mjs";
import { saveWork, getWork, listWorks, saveActivity, listActivities } from "./store-v5.mjs";

export async function createBuildWork({ projectId, title, legacyReqId = null }) {
  const work = newWork({ projectId, title, mode: "build", legacyReqId });
  const activities = createBuildActivities(work.id);
  if (activities.length) work.currentActivityId = activities[0].id;
  work.status = "active";
  await saveWork(work);
  for (const activity of activities) await saveActivity(activity);
  return { work, activities };
}

export async function getBuildWork(id) {
  const work = await getWork(id);
  if (!work) return null;
  const activities = (await listActivities(id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { work, activities };
}

export { listWorks };
