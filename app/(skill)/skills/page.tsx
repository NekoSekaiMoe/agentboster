'use client';

import { Download, FileText, Loader2, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  buildSkillArchiveAction,
  createSkillAction,
  deleteSkillAction,
  getSkillDetailAction,
  getSkillFileContentAction,
  getSkillImportJobAction,
  listActiveSkillImportJobsAction,
  listSkillsAction,
  startSkillImportAction,
  updateSkillFileAction,
} from '@/app/(skill)/actions';
import type { SkillDetail, SkillMeta } from '@/types/skills';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';

let nextFileId = 0;

interface CreateFileEntry {
  id: number;
  path: string;
  content: string;
}

type ViewMode = 'list' | 'create' | 'import' | 'detail';

export default function SkillsPage() {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedSkill, setSelectedSkill] = useState<SkillDetail | null>(null);
  const [selectedFileContent, setSelectedFileContent] = useState<string | null>(
    null,
  );
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [editingFileContent, setEditingFileContent] = useState<string | null>(
    null,
  );
  const [savingFile, setSavingFile] = useState(false);

  // Create form
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createFiles, setCreateFiles] = useState<CreateFileEntry[]>([
    { id: nextFileId++, path: 'SKILL.md', content: '' },
  ]);

  // Import form
  const [gitURL, setGitURL] = useState('');
  const [importing, setImporting] = useState(false);
  const [importJob, setImportJob] = useState<{
    jobId: string;
    gitURL: string;
  } | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const importPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [pendingDeleteSkill, setPendingDeleteSkill] = useState<string | null>(
    null,
  );

  const isAnyLoading = loading || loadingDetail || !!loadingFile || importing;

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      setSkills(await listSkillsAction());
    } catch {
      toast.error('Failed to load skills');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadActiveImportJobs = useCallback(async () => {
    // Skip if already importing (user initiated)
    if (importJob) return;
    try {
      const data = await listActiveSkillImportJobsAction();
      if (data.length > 0) {
        // Restore the first active job (typically only one at a time)
        const activeJob = data[0];
        setImportJob({ jobId: activeJob.jobId, gitURL: activeJob.gitURL });
        setImporting(true);
      }
    } catch {
      // Silent failure - don't block page load
    }
  }, [importJob]);

  useEffect(() => {
    loadSkills();
    loadActiveImportJobs();
  }, [loadSkills, loadActiveImportJobs]);

  // Poll import job until done or error
  useEffect(() => {
    if (!importJob) return;
    const startedAt = Date.now();
    const MAX_WAIT_MS = 5 * 60 * 1000;

    importPollRef.current = setInterval(async () => {
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        clearInterval(importPollRef.current ?? undefined);
        importPollRef.current = null;
        setImportJob(null);
        setImporting(false);
        toast.error('Import timed out — check server logs');
        return;
      }
      try {
        const job = await getSkillImportJobAction(importJob.jobId);
        if (!job) return;
        if (job.status === 'done') {
          clearInterval(importPollRef.current ?? undefined);
          importPollRef.current = null;
          setImportJob(null);
          setImporting(false);
          toast.success(`Imported ${job.importedNames?.length ?? 0} skill(s)`);
          await loadSkills();
        } else if (job.status === 'error') {
          clearInterval(importPollRef.current ?? undefined);
          importPollRef.current = null;
          setImportJob(null);
          setImporting(false);
          toast.error(job.error || 'Import failed');
        }
      } catch {
        // transient fetch error — keep polling
      }
    }, 2000);

    return () => {
      if (importPollRef.current) clearInterval(importPollRef.current);
    };
  }, [importJob, loadSkills]);

  function resetCreateForm() {
    setCreateName('');
    setCreateDescription('');
    setCreateFiles([{ id: nextFileId++, path: 'SKILL.md', content: '' }]);
  }

  function addCreateFile() {
    setCreateFiles((prev) => [
      ...prev,
      { id: nextFileId++, path: '', content: '' },
    ]);
  }

  function removeCreateFile(id: number) {
    setCreateFiles((prev) => prev.filter((f) => f.id !== id));
  }

  function updateCreateFile(
    id: number,
    field: 'path' | 'content',
    value: string,
  ) {
    setCreateFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, [field]: value } : f)),
    );
  }

  async function createSkill() {
    const validFiles = createFiles.filter(
      (f) => f.path.trim() && f.content.trim(),
    );
    if (!createName.trim() || validFiles.length === 0) {
      toast.error('Name and at least one file with content are required');
      return;
    }
    try {
      await createSkillAction({
        name: createName.trim(),
        description: createDescription.trim(),
        files: validFiles,
      });
      toast.success('Skill created');
      resetCreateForm();
      setViewMode('list');
      await loadSkills();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to create skill',
      );
    }
  }

  async function importFromGit() {
    if (!gitURL.trim()) return;
    setImporting(true);
    try {
      const data = await startSkillImportAction({ gitURL: gitURL.trim() });
      // Optimistic: switch to list immediately and start polling
      setGitURL('');
      setViewMode('list');
      setImportJob({ jobId: data.jobId, gitURL: data.gitURL });
      // `importing` stays true until the job finishes
    } catch (error) {
      setImporting(false);
      toast.error(
        error instanceof Error ? error.message : 'Failed to import from Git',
      );
    }
  }

  async function deleteSkill(name: string) {
    setDeleting(name);
    try {
      await deleteSkillAction(name);
      toast.success(`Skill "${name}" deleted`);
      setSkills((prev) => prev.filter((s) => s.name !== name));
      if (selectedSkill?.name === name) {
        setSelectedSkill(null);
        setViewMode('list');
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to delete skill',
      );
    } finally {
      setDeleting(null);
    }
  }

  async function downloadSkillArchive(name: string) {
    setDownloading(name);
    try {
      const archive = await buildSkillArchiveAction(name);
      const binary = atob(archive.contentBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const blob = new Blob([bytes], { type: archive.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = archive.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to download');
    } finally {
      setDownloading(null);
    }
  }

  async function viewSkillDetail(name: string) {
    setLoadingDetail(true);
    try {
      const data = await getSkillDetailAction(name);
      setSelectedSkill(data);
      setSelectedFileContent(null);
      setSelectedFilePath(null);
      setViewMode('detail');
    } catch {
      toast.error('Failed to load skill detail');
    } finally {
      setLoadingDetail(false);
    }
  }

  async function viewFile(skillName: string, filePath: string) {
    setLoadingFile(filePath);
    try {
      const data = await getSkillFileContentAction({
        skillName,
        filePath,
      });
      setSelectedFileContent(data.content);
      setSelectedFilePath(filePath);
      setEditingFileContent(null);
    } catch {
      toast.error('Failed to load file');
    } finally {
      setLoadingFile(null);
    }
  }

  async function saveFile() {
    if (!selectedSkill || !selectedFilePath || editingFileContent === null)
      return;
    setSavingFile(true);
    try {
      const result = await updateSkillFileAction({
        skillName: selectedSkill.name,
        filePath: selectedFilePath,
        content: editingFileContent,
      });
      setSelectedFileContent(editingFileContent);
      setEditingFileContent(null);
      setSelectedSkill(result.skill);
      toast.success(`Saved ${selectedFilePath}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to save file',
      );
    } finally {
      setSavingFile(false);
    }
  }

  function formatTime(ts: number) {
    if (!ts) return '';
    return new Date(ts).toLocaleString();
  }

  return (
    <div className="flex flex-col min-w-0 h-dvh bg-background">
      {/* Top progress bar — shown during any async operation */}
      {isAnyLoading && (
        <div className="fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-primary/10 pointer-events-none">
          <div
            className="h-full w-1/2 bg-primary rounded-full"
            style={{ animation: 'progress-indeterminate 1.4s linear infinite' }}
          />
        </div>
      )}

      <header className="flex sticky top-0 bg-background py-3 items-center px-4 border-b gap-2">
        <h1 className="text-lg font-semibold">Skills</h1>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setViewMode('import')}
          >
            <Download className="size-4 mr-1" /> Import Git
          </Button>
          <Button size="sm" onClick={() => setViewMode('create')}>
            <Plus className="size-4 mr-1" /> Create
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">
              Skills are a knowledge base owned by the Agent, you can add them
              manually or from a Git repository.
            </p>
          </CardHeader>
        </Card>
        {viewMode === 'import' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Import from Git</CardTitle>
              <CardDescription>
                Enter the URL of a Git repository to import skills from. The git
                repo should contain a <span className="font-mono">skills</span>{' '}
                folder with one subfolder per skill, each containing the skill
                files.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                value={gitURL}
                onChange={(e) => setGitURL(e.target.value)}
                placeholder="https://github.com/user/repo"
              />
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setViewMode('list')}>
                  Cancel
                </Button>
                <Button onClick={importFromGit} disabled={importing}>
                  {importing && (
                    <Loader2 className="size-4 animate-spin mr-2" />
                  )}
                  Import
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {viewMode === 'create' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Create Skill</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <label htmlFor="skill-name" className="text-sm font-medium">
                  Name
                </label>
                <Input
                  id="skill-name"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="my-skill"
                />
              </div>
              <div>
                <label
                  htmlFor="skill-description"
                  className="text-sm font-medium"
                >
                  Description
                </label>
                <Input
                  id="skill-description"
                  value={createDescription}
                  onChange={(e) => setCreateDescription(e.target.value)}
                  placeholder="What this skill does"
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Files</span>
                  <Button size="sm" variant="outline" onClick={addCreateFile}>
                    <Plus className="size-3 mr-1" /> Add File
                  </Button>
                </div>
                {createFiles.map((file) => (
                  <div
                    key={file.id}
                    className="space-y-2 border rounded-md p-3"
                  >
                    <div className="flex items-center gap-2">
                      <Input
                        value={file.path}
                        onChange={(e) =>
                          updateCreateFile(file.id, 'path', e.target.value)
                        }
                        placeholder="File path (e.g. SKILL.md)"
                        className="flex-1"
                      />
                      {createFiles.length > 1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive shrink-0"
                          onClick={() => removeCreateFile(file.id)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                    <Textarea
                      value={file.content}
                      onChange={(e) =>
                        updateCreateFile(file.id, 'content', e.target.value)
                      }
                      rows={6}
                      placeholder="File content..."
                      className="font-mono text-sm"
                    />
                  </div>
                ))}
              </div>

              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={() => {
                    setViewMode('list');
                    resetCreateForm();
                  }}
                >
                  Cancel
                </Button>
                <Button onClick={createSkill}>Create</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {viewMode === 'detail' && selectedSkill && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setViewMode('list');
                  setSelectedSkill(null);
                  setSelectedFileContent(null);
                  setSelectedFilePath(null);
                  setEditingFileContent(null);
                }}
              >
                ← Back
              </Button>
              <h2 className="text-lg font-semibold">{selectedSkill.name}</h2>
              <div className="ml-auto flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => downloadSkillArchive(selectedSkill.name)}
                  disabled={downloading === selectedSkill.name || isAnyLoading}
                >
                  {downloading === selectedSkill.name ? (
                    <Loader2 className="size-4 animate-spin mr-2" />
                  ) : (
                    <Download className="size-4 mr-1" />
                  )}
                  Download
                </Button>
              </div>
            </div>
            {selectedSkill.description && (
              <p className="text-sm text-muted-foreground">
                {selectedSkill.description}
              </p>
            )}
            <div className="text-xs text-muted-foreground flex flex-wrap gap-2">
              <code className="px-2 py-1 rounded bg-muted">
                {selectedSkill.sourceType}
              </code>
              {selectedSkill.gitURL && (
                <code className="px-2 py-1 rounded bg-muted">
                  {selectedSkill.gitURL}
                </code>
              )}
              {selectedSkill.updatedAt > 0 && (
                <code className="px-2 py-1 rounded bg-muted">
                  {formatTime(selectedSkill.updatedAt)}
                </code>
              )}
              <code className="px-2 py-1 rounded bg-muted">
                {selectedSkill.files.length} file(s)
              </code>
            </div>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Files</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {selectedSkill.files.map((file) => (
                  <Button
                    key={file.path}
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start font-mono text-sm"
                    disabled={!!loadingFile}
                    onClick={() => viewFile(selectedSkill.name, file.path)}
                  >
                    {loadingFile === file.path ? (
                      <Loader2 className="size-4 mr-2 shrink-0 animate-spin" />
                    ) : (
                      <FileText className="size-4 mr-2 shrink-0" />
                    )}
                    {file.path}
                  </Button>
                ))}
              </CardContent>
            </Card>
            {selectedFileContent !== null && selectedFilePath && (
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-mono truncate">
                    {selectedFilePath}
                  </CardTitle>
                  <div className="flex gap-2 shrink-0 ml-2">
                    {editingFileContent === null ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setEditingFileContent(selectedFileContent)
                        }
                      >
                        Edit
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setEditingFileContent(null)}
                          disabled={savingFile}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={saveFile}
                          disabled={savingFile}
                        >
                          {savingFile && (
                            <Loader2 className="size-4 animate-spin mr-2" />
                          )}
                          Save
                        </Button>
                      </>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  {editingFileContent === null ? (
                    <pre className="text-xs bg-muted p-3 rounded overflow-auto max-h-96 whitespace-pre-wrap">
                      {selectedFileContent}
                    </pre>
                  ) : (
                    <Textarea
                      value={editingFileContent}
                      onChange={(e) => setEditingFileContent(e.target.value)}
                      rows={16}
                      className="font-mono text-xs"
                    />
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {viewMode === 'list' &&
          (loading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                <Card key={`skeleton-${i}`}>
                  <CardContent className="pt-4 flex items-start justify-between gap-4">
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-64" />
                      <div className="flex flex-wrap gap-2">
                        <Skeleton className="h-3 w-16" />
                        <Skeleton className="h-3 w-24" />
                        <Skeleton className="h-3 w-20" />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Skeleton className="size-8" />
                      <Skeleton className="size-8" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {/* Optimistic import pending card */}
              {importJob && (
                <Card className="border-dashed opacity-70">
                  <CardContent className="pt-4 flex items-center gap-3">
                    <Loader2 className="size-4 animate-spin text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="font-medium text-sm">Importing…</div>
                      <p className="text-xs text-muted-foreground truncate">
                        {importJob.gitURL}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}
              {skills.length === 0 && !importJob && (
                <div className="text-sm text-muted-foreground p-6 border border-dashed rounded-lg text-center">
                  No skills installed
                </div>
              )}
              {skills.map((skill) => (
                <Card
                  key={skill.name}
                  className="cursor-pointer hover:bg-accent/50 transition-colors"
                >
                  <CardContent className="pt-4 flex items-start justify-between gap-4">
                    <button
                      type="button"
                      className="flex-1 text-left"
                      onClick={() => viewSkillDetail(skill.name)}
                      disabled={loadingDetail}
                    >
                      <div className="font-medium text-sm">{skill.name}</div>
                      {skill.description && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {skill.description}
                        </p>
                      )}
                      <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-2">
                        <span>{skill.sourceType}</span>
                        {skill.gitURL && (
                          <span className="truncate max-w-48">
                            {skill.gitURL}
                          </span>
                        )}
                        {skill.updatedAt > 0 && (
                          <span>{formatTime(skill.updatedAt)}</span>
                        )}
                        <span>{skill.fileCount} file(s)</span>
                      </div>
                    </button>
                    <div className="flex gap-2 items-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        disabled={downloading === skill.name}
                        onClick={(e) => {
                          e.stopPropagation();
                          downloadSkillArchive(skill.name);
                        }}
                      >
                        {downloading === skill.name ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Download className="size-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive shrink-0"
                        disabled={deleting === skill.name}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDeleteSkill(skill.name);
                        }}
                      >
                        {deleting === skill.name ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ))}
      </div>

      <AlertDialog
        open={pendingDeleteSkill !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeleteSkill(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete skill?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{pendingDeleteSkill}" and all its
              files. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDeleteSkill) {
                  void deleteSkill(pendingDeleteSkill);
                  setPendingDeleteSkill(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
