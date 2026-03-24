/**
 * One-time migration: LLM-based review of all open tasks.
 * Sends open tasks in batches to haiku for re-classification.
 * Tasks that are completion reports or already done → resolved.
 *
 * Usage: node --import tsx/esm src/memory/migrate-tasks.ts [--dry-run]
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';
import { OllamaEmbeddingProvider, EmbeddingService } from './embedding-provider.js';
import { MemoryService, type MemoryUnit } from './memory-service.js';
import { ChatService, ClaudeSdkChatProvider } from './chat-provider.js';
const DRY_RUN = process.argv.includes('--dry-run');

const REVIEW_SYSTEM_PROMPT = `You are reviewing a database of "open tasks" for accuracy. Many of these are NOT real open tasks — they are completion reports, past events, or one-time actions that were misclassified.

For each task, decide:
- "keep_open" — This is genuinely an unfinished task that still needs action
- "resolve" — This is already done, a completion report, a past event, or a one-time action that was completed
- "reclassify" — This is not a task at all (it's a fact, decision, or observation)

## Rules
1. If the text describes something that WAS DONE (past tense, "수정", "구현", "완료", "추가", "삭제", "resolved"), it's NOT an open task → resolve or reclassify as fact
2. If the text is a date-specific event and the date has passed → resolve
3. If the text is a suggestion/proposal, not an action item → reclassify as decision or fact
4. If the text describes an ongoing need or future action → keep_open
5. When in doubt, keep_open is safer

CRITICAL: Respond with ONLY a raw JSON array. No explanation, no markdown, no text before or after.
Each element:
{"id":"<task id>","action":"keep_open"|"resolve"|"reclassify","newKind":"fact"|"decision"|null,"reason":"<brief reason in Korean>"}

Example response (just the array, nothing else):
[{"id":"abc","action":"resolve","newKind":null,"reason":"이미 완료된 작업"},{"id":"def","action":"keep_open","newKind":null,"reason":"아직 미완"}]`;

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== LIVE RUN ===');

  // Init services
  const ep = new OllamaEmbeddingProvider();
  const es = new EmbeddingService(ep);
  await es.initialize();
  const ms = new MemoryService(es);
  await ms.initialize();
  const chat = new ChatService(new ClaudeSdkChatProvider({ model: 'haiku' }));
  await chat.initialize();

  // Gather all open tasks
  const projects = await ms.listProjects();
  const allTasks: (MemoryUnit & { project: string })[] = [];

  for (const p of projects) {
    const items = await ms.getByProject(p, { limit: 500, statuses: ['open'] });
    const tasks = items.filter(i => i.kind === 'task');
    for (const t of tasks) {
      allTasks.push({ ...t, project: p });
    }
  }

  console.log(`Found ${allTasks.length} open tasks across ${projects.length} projects`);

  // Load project → directory mapping from settings.json
  const settingsPath = join(homedir(), '.sleep-code', 'settings.json');
  let projectDirs: Record<string, string> = {};
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    for (const dir of (settings.allowedDirectories ?? []) as string[]) {
      const name = basename(dir);
      projectDirs[name] = dir;
    }
    // Also try parent folder name for nested repos (e.g., cpik-inc)
    console.log(`Loaded ${Object.keys(projectDirs).length} project directories`);
  } catch { /* ignore */ }

  // Gather git logs per project
  const gitLogs: Record<string, string> = {};
  for (const [name, dir] of Object.entries(projectDirs)) {
    try {
      const log = execSync(`git -C "${dir}" log --oneline -50 2>/dev/null`, { encoding: 'utf-8' });
      gitLogs[name] = log.trim();
      console.log(`  Git log for ${name}: ${log.trim().split('\n').length} commits`);
    } catch { /* not a git repo or no commits */ }
  }

  // Process in batches of 20
  const BATCH_SIZE = 20;
  let resolved = 0;
  let reclassified = 0;
  let kept = 0;
  let errors = 0;

  for (let i = 0; i < allTasks.length; i += BATCH_SIZE) {
    const batch = allTasks.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`\n--- Batch ${batchNum} (${batch.length} tasks) ---`);

    const taskList = batch.map(t => ({
      id: t.id,
      project: t.project,
      text: t.text,
      priority: t.priority,
      topicKey: t.topicKey,
      createdAt: t.createdAt,
    }));

    // Collect relevant git logs for projects in this batch
    const batchProjects = [...new Set(batch.map(t => t.project))];
    let gitContext = '';
    for (const p of batchProjects) {
      // Try exact name and common variations
      const log = gitLogs[p] || gitLogs[p.replace(/-/g, '_')];
      if (log) {
        gitContext += `\n\n## Git log for "${p}" (recent 50 commits):\n${log}`;
      }
    }

    const userPrompt = `Today is ${new Date().toISOString().slice(0, 10)}. Review these open tasks.

IMPORTANT: Cross-reference tasks against the git log below. If a commit clearly implements/fixes/adds what the task describes, mark it as "resolve".
${gitContext ? gitContext : '\n(No git log available for these projects)'}

Open tasks to review:
${JSON.stringify(taskList, null, 2)}`;

    try {
      // Force fresh session per batch to avoid context contamination
      const freshChat = new ChatService(new ClaudeSdkChatProvider({ model: 'sonnet' }));
      await freshChat.initialize();
      const response = await freshChat.chat([
        { role: 'system', content: REVIEW_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ]);

      // Parse response (strip markdown code blocks if present)
      if (!response || response.trim().length === 0) {
        console.error(`  ❌ Batch ${batchNum}: empty response from LLM`);
        errors++;
        continue;
      }
      let cleaned = response.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
      // Extract JSON array if surrounded by text
      const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        cleaned = arrayMatch[0];
      }
      console.log(`  📝 Response length: ${cleaned.length} chars`);
      const results = JSON.parse(cleaned) as Array<{
        id: string;
        action: 'keep_open' | 'resolve' | 'reclassify';
        newKind?: string | null;
        reason: string;
      }>;

      for (const r of results) {
        const task = batch.find(t => t.id === r.id);
        if (!task) continue;

        if (r.action === 'resolve') {
          resolved++;
          console.log(`  ✅ RESOLVE [${task.project}] ${task.text.slice(0, 60)} — ${r.reason}`);
          if (!DRY_RUN) {
            await ms.updateStatus(task.id, 'resolved');
          }
        } else if (r.action === 'reclassify') {
          reclassified++;
          console.log(`  🔄 RECLASS → ${r.newKind} [${task.project}] ${task.text.slice(0, 60)} — ${r.reason}`);
          if (!DRY_RUN && r.newKind) {
            await ms.updateFields(task.id, { kind: r.newKind as any });
          }
        } else {
          kept++;
          console.log(`  ⏳ KEEP [${task.project}] ${task.text.slice(0, 60)}`);
        }
      }
    } catch (err) {
      errors++;
      console.error(`  ❌ Batch ${batchNum} failed:`, err);
    }
  }

  console.log(`\n=== MIGRATION COMPLETE ===`);
  console.log(`Resolved: ${resolved}`);
  console.log(`Reclassified: ${reclassified}`);
  console.log(`Kept open: ${kept}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total: ${allTasks.length}`);

  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
