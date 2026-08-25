import fs from "node:fs/promises";
import path from "node:path";

/**
 * Creates a JSON-file repository for one collection directory.
 * Filesystem layout, serialization, and missing-file handling stay behind this interface.
 */
export function createJsonDirectoryRepository(directory) {
  const file = (id) => path.join(directory, `${id}.json`);

  async function ensureDirectory() {
    await fs.mkdir(directory, { recursive: true });
  }

  return {
    async save(value) {
      await ensureDirectory();
      value.updatedAt = new Date().toISOString();
      await fs.writeFile(file(value.id), JSON.stringify(value, null, 2));
      return value;
    },

    async get(id) {
      try {
        return JSON.parse(await fs.readFile(file(id), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },

    async list(predicate = () => true) {
      await ensureDirectory();
      const names = await fs.readdir(directory);
      const values = await Promise.all(
        names
          .filter((name) => name.endsWith(".json"))
          .map((name) =>
            fs.readFile(path.join(directory, name), "utf8").then(JSON.parse),
          ),
      );
      return values.filter(predicate);
    },
  };
}
