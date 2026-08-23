import React, { useCallback, useEffect, useState } from "react";
import { Check, ChevronsUpDown, FolderGit2, Plus } from "lucide-react";
import WorkView from "../build/WorkView.jsx";
import { postJson, readJsonResponse } from "../shared/api-client.js";

const api = {
  projects: {
    list: () => fetch("/api/projects").then(readJsonResponse),
    create: (project) => postJson("/api/projects", project),
  },
  works: {
    list: (projectId) =>
      fetch(`/api/v5/works${projectId ? `?projectId=${projectId}` : ""}`).then(
        readJsonResponse,
      ),
    create: (title, projectId) =>
      postJson("/api/v5/works", { title, projectId }),
  },
};

const workIdFromUrl = () =>
  new URLSearchParams(window.location.search).get("work");

function writeWorkToUrl(workId) {
  const url = new URL(window.location.href);
  if (workId) url.searchParams.set("work", workId);
  else url.searchParams.delete("work");
  if (url.href !== window.location.href)
    window.history.replaceState(null, "", url);
}

export default function App() {
  const [works, setWorks] = useState([]);
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [activeWorkId, setActiveWorkId] = useState(workIdFromUrl);
  const [appError, setAppError] = useState("");

  const refreshWorks = useCallback(async () => {
    setWorks(await api.works.list(showAllProjects ? null : activeProjectId));
  }, [activeProjectId, showAllProjects]);

  useEffect(() => {
    api.projects
      .list()
      .then((items) => {
        setProjects(items);
        setActiveProjectId((current) => current || items[0]?.id || null);
      })
      .catch((error) => setAppError(error.message));
  }, []);
  useEffect(() => {
    refreshWorks().catch((error) => setAppError(error.message));
  }, [refreshWorks]);
  useEffect(() => {
    writeWorkToUrl(activeWorkId);
  }, [activeWorkId]);

  async function createProject(project) {
    const created = await api.projects.create(project);
    if (created?.error) return created;
    const items = await api.projects.list();
    setProjects(items);
    setActiveProjectId(created.id);
    return created;
  }

  async function createWork(title) {
    if (!activeProjectId) return;
    setAppError("");
    try {
      const created = await api.works.create(title, activeProjectId);
      await refreshWorks();
      setActiveWorkId(created.work.id);
    } catch (error) {
      setAppError(error.message);
    }
  }

  const activeProject = projects.find(
    (project) => project.id === activeProjectId,
  );

  return (
    <div className="flex h-screen w-full bg-white text-sm text-neutral-900 antialiased">
      <Sidebar
        works={works}
        activeWorkId={activeWorkId}
        onPickWork={setActiveWorkId}
        projects={projects}
        activeProject={activeProject}
        onProjectChange={setActiveProjectId}
        showAllProjects={showAllProjects}
        onToggleShowAll={() => setShowAllProjects((value) => !value)}
        onCreateProject={createProject}
        onCreateWork={createWork}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        {appError && (
          <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
            {appError}
          </div>
        )}
        {activeWorkId ? (
          <WorkView workId={activeWorkId} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-neutral-500">
            选择一个 BUILD 工作，或创建新的工作
          </div>
        )}
      </main>
    </div>
  );
}

function Sidebar({
  works,
  activeWorkId,
  onPickWork,
  projects,
  activeProject,
  onProjectChange,
  showAllProjects,
  onToggleShowAll,
  onCreateProject,
  onCreateWork,
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);

  function submitWork() {
    if (!title.trim()) return;
    onCreateWork(title.trim());
    setTitle("");
    setAdding(false);
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-200">
      <div className="relative flex h-12 shrink-0 items-center justify-between border-b border-neutral-200 px-4">
        <button
          onClick={() => setPickerOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-neutral-50"
        >
          <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          <span className="truncate font-medium">
            {activeProject?.name || "选择项目"}
          </span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-neutral-400" />
        </button>
        <button
          onClick={() => setAdding(true)}
          disabled={!activeProject}
          className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-30"
          title="新建工作"
        >
          <Plus className="h-4 w-4" />
        </button>
        {pickerOpen && (
          <ProjectPicker
            projects={projects}
            activeProject={activeProject}
            showAllProjects={showAllProjects}
            onPick={(projectId) => {
              onProjectChange(projectId);
              setPickerOpen(false);
            }}
            onToggleShowAll={onToggleShowAll}
            onCreate={() => {
              setCreatingProject(true);
              setPickerOpen(false);
            }}
          />
        )}
      </div>
      <div className="shrink-0 border-b border-neutral-200 px-4 py-2 text-xs text-neutral-500">
        BUILD {works.length}
      </div>
      {creatingProject && (
        <NewProjectForm
          onCancel={() => setCreatingProject(false)}
          onCreate={async (project) => {
            const created = await onCreateProject(project);
            if (!created?.error) setCreatingProject(false);
            return created;
          }}
        />
      )}
      {adding && (
        <div className="shrink-0 border-b border-neutral-200 p-3">
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitWork();
              if (event.key === "Escape") setAdding(false);
            }}
            placeholder="BUILD 工作标题，回车创建"
            className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 outline-none placeholder:text-neutral-400"
          />
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-3">
        <div className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
          BUILD
        </div>
        <div className="space-y-0.5">
          {works.map((work) => (
            <button
              key={work.id}
              onClick={() => onPickWork(work.id)}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left ${activeWorkId === work.id ? "bg-neutral-100" : "hover:bg-neutral-50"}`}
            >
              <span className="flex-1 truncate">{work.title}</span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}

function ProjectPicker({
  projects,
  activeProject,
  showAllProjects,
  onPick,
  onToggleShowAll,
  onCreate,
}) {
  return (
    <div className="absolute left-0 top-12 z-10 w-72 rounded-md border border-neutral-200 bg-white p-1.5 shadow-lg">
      {projects.map((project) => (
        <button
          key={project.id}
          onClick={() => onPick(project.id)}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${project.id === activeProject?.id ? "bg-neutral-100" : "hover:bg-neutral-50"}`}
        >
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          {project.id === activeProject?.id && (
            <Check className="h-3 w-3 shrink-0 text-emerald-600" />
          )}
        </button>
      ))}
      <div className="my-1 border-t border-neutral-200" />
      <label className="flex items-center gap-2 px-2 py-1.5 text-xs text-neutral-600">
        <input
          type="checkbox"
          checked={showAllProjects}
          onChange={onToggleShowAll}
        />
        显示全部项目
      </label>
      <button
        onClick={onCreate}
        className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-neutral-600 hover:bg-neutral-50"
      >
        <Plus className="h-3 w-3" /> 新建项目
      </button>
    </div>
  );
}

function NewProjectForm({ onCreate, onCancel }) {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [worktreesDir, setWorktreesDir] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [error, setError] = useState(null);

  async function submit() {
    setError(null);
    try {
      const created = await onCreate({
        name: name.trim(),
        repoPath: repoPath.trim(),
        worktreesDir: worktreesDir.trim(),
        baseBranch: baseBranch.trim(),
      });
      if (created?.error) setError(created.error);
    } catch (submitError) {
      setError(submitError.message);
    }
  }

  return (
    <div className="shrink-0 space-y-1.5 border-b border-neutral-200 p-3">
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="项目名称"
        className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs outline-none"
      />
      <input
        value={repoPath}
        onChange={(event) => setRepoPath(event.target.value)}
        placeholder="仓库路径 repoPath"
        className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs outline-none"
      />
      <input
        value={worktreesDir}
        onChange={(event) => setWorktreesDir(event.target.value)}
        placeholder="worktree 目录 worktreesDir"
        className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs outline-none"
      />
      <input
        value={baseBranch}
        onChange={(event) => setBaseBranch(event.target.value)}
        placeholder="基线分支（可留空）"
        className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs outline-none"
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-1.5">
        <button
          onClick={submit}
          disabled={!name.trim() || !repoPath.trim() || !worktreesDir.trim()}
          className="flex-1 rounded-md bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-30"
        >
          创建
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs"
        >
          取消
        </button>
      </div>
    </div>
  );
}
