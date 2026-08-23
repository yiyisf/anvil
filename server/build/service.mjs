import { newWork } from "./domain.mjs";
import { createBuildActivities } from "./flow.mjs";
import {
  saveWork,
  getWork,
  listWorks,
  saveActivity,
  listActivities,
  listInterruptions,
} from "../persistence/build-repository.mjs";

export async function createBuildWork({
  projectId,
  title,
  legacyReqId = null,
}) {
  const work = newWork({ projectId, title, mode: "build", legacyReqId });
  const activities = createBuildActivities(work.id);
  if (activities.length) work.currentActivityId = activities[0].id;
  await saveWork(work);
  for (const activity of activities) await saveActivity(activity);
  return { work, activities };
}

export async function getBuildWork(id) {
  const work = await getWork(id);
  if (!work) return null;
  const activities = (await listActivities(id)).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const interruptions = (await listInterruptions(id)).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  return { work, activities, interruptions };
}

export { listWorks };
