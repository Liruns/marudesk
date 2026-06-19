import { check, passedCount } from '../harness-kit';
import { listMcpTools } from './mcp.ts';
import { editPlanStep, updatePlanTool } from './plan.ts';
import { S } from './loop-state.ts';
import { emptyAgentChatState } from '../../shared/agent.ts';

/**
 * Headless harness for the update_plan tool / Taskboard (v5 §G2). Runs with
 * `node --experimental-strip-types` (package.json `harness:plan`). updatePlanTool
 * is loop-intercepted and mutates S.state.plan, so we drive it directly and
 * assert the projection: parsing/validation, stable slug ids, and the
 * transcript-jump anchor merge (C).
 */

/* ── listed to the model, ungated ─────────────────────────────────────── */
const listed = listMcpTools();
check('update_plan is listed for the model', listed.some((t) => t.name === 'update_plan'));
check('update_plan is not gated', listed.find((t) => t.name === 'update_plan')?.gated !== true);

S.state = emptyAgentChatState();

/* ── parsing + validation ─────────────────────────────────────────────── */
const bad = updatePlanTool({});
check('missing steps is an error', bad.isError === true);
check('no plan set on error', S.state.plan === null);

const empty = updatePlanTool({ steps: [{ title: '   ' }, 42] });
check('all-invalid steps is an error', empty.isError === true);

const ok = updatePlanTool({
  steps: [
    { title: 'Read the code', status: 'done' },
    { title: 'Write the fix', status: 'in_progress', note: 'editing loop.ts' },
    { title: 'Verify', status: 'bogus' },
  ],
});
check('valid plan returns ok', ok.isError !== true);
check('plan projected with 3 steps', S.state.plan?.steps.length === 3);
check('unknown status falls back to pending', S.state.plan?.steps[2].status === 'pending');
check('note is kept', S.state.plan?.steps[1].note === 'editing loop.ts');
check('summary reports done count', ok.summary.includes('1/3'));

/* ── stable slug ids across updates ───────────────────────────────────── */
const firstId = S.state.plan!.steps[1].id;
updatePlanTool({
  steps: [
    { title: 'Read the code', status: 'done' },
    { title: 'Write the fix', status: 'done' },
  ],
});
const sameStep = S.state.plan!.steps.find((s) => s.title === 'Write the fix');
check('a step keeps its id across updates (stable slug)', sameStep?.id === firstId);
check('replacing the plan drops removed steps', S.state.plan!.steps.length === 2);

/* ── anchor: set on activation, preserved across updates (C) ──────────── */
S.state = emptyAgentChatState();
S.state.messages = [{ id: 'm-1', role: 'assistant', parts: [], timestamp: 1 }];
updatePlanTool({ steps: [{ title: 'Plan a thing', status: 'pending' }] });
check('a pending step gets no anchor', S.state.plan!.steps[0].anchorMessageId === undefined);

S.state.messages = [{ id: 'm-2', role: 'assistant', parts: [], timestamp: 2 }];
updatePlanTool({ steps: [{ title: 'Plan a thing', status: 'in_progress' }] });
check('an active step anchors to the latest message', S.state.plan!.steps[0].anchorMessageId === 'm-2');

S.state.messages = [{ id: 'm-3', role: 'assistant', parts: [], timestamp: 3 }];
updatePlanTool({ steps: [{ title: 'Plan a thing', status: 'done' }] });
check('the anchor is preserved across later updates', S.state.plan!.steps[0].anchorMessageId === 'm-2');

/* ── steerable plan: status toggle / rename / remove (U5) ─────────────── */
S.state = emptyAgentChatState();
updatePlanTool({ steps: [{ title: 'Alpha' }, { title: 'Beta' }] });
const alphaId = S.state.plan!.steps[0].id;
check('editPlanStep toggles status', editPlanStep(alphaId, { status: 'done' }) &&
  S.state.plan!.steps[0].status === 'done');
check('editPlanStep renames a step', editPlanStep(alphaId, { title: 'Alpha renamed' }) &&
  S.state.plan!.steps[0].title === 'Alpha renamed');
check('editPlanStep on a missing id is a no-op', editPlanStep('nope', { status: 'done' }) === false);
check('editPlanStep removes a step', editPlanStep(alphaId, { remove: true }) &&
  S.state.plan!.steps.length === 1);

/* ── steerable plan: human-added node persists across update_plan ──────── */
S.state = emptyAgentChatState();
updatePlanTool({ steps: [{ title: 'Step one' }, { title: 'Step two' }] });
const stepOneId = S.state.plan!.steps[0].id;
check('add with no plan/anchor appends a user step',
  editPlanStep('', { add: { title: 'My step' } }) &&
  S.state.plan!.steps.length === 3 &&
  S.state.plan!.steps[2].userAdded === true);
check('add after an anchor inserts in place',
  editPlanStep('', { add: { title: 'After one', after: stepOneId } }) &&
  S.state.plan!.steps[1].title === 'After one' &&
  S.state.plan!.steps[1].userAdded === true);
// The model replaces the whole plan and lists none of the user's steps…
updatePlanTool({ steps: [{ title: 'Step one' }, { title: 'Step two' }, { title: 'Step three' }] });
const titles = S.state.plan!.steps.map((s) => s.title);
check('model replace keeps the user steps', titles.includes('My step') && titles.includes('After one'));
check('user steps sink to the end on replace', titles.slice(-2).every((tl) => tl === 'My step' || tl === 'After one'));
check('user steps stay flagged after replace',
  S.state.plan!.steps.filter((s) => s.userAdded).length === 2);
const addOnly = updatePlanTool({ steps: [{ title: 'My step' }] });
check('a model step matching a user title takes over (sheds userAdded)',
  addOnly.isError !== true && S.state.plan!.steps.some((s) => s.title === 'My step' && !s.userAdded));

S.state = emptyAgentChatState();
console.log(`\nplan harness: ${passedCount()} assertions passed`);
