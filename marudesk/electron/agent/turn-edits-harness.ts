import assert from 'node:assert/strict';
import type { AgentEdit, AgentMessage } from '../../shared/agent.ts';
import {
  latestChangesRowKey,
  transcriptRowsWithTurnChanges,
} from '../../src/features/agent/chat/turn-edits.ts';

function textMessage(input: {
  readonly id: string;
  readonly role: AgentMessage['role'];
  readonly timestamp: number;
  readonly turnId?: string;
}): AgentMessage {
  return {
    id: input.id,
    role: input.role,
    parts: [{ type: 'text', text: input.id }],
    timestamp: input.timestamp,
    ...(input.turnId ? { turnId: input.turnId } : {}),
  };
}

function edit(input: {
  readonly id: string;
  readonly turnId: string;
  readonly timestamp: number;
}): AgentEdit {
  return {
    id: input.id,
    turnId: input.turnId,
    path: `${input.id}.txt`,
    kind: 'edit',
    before: 'before',
    after: 'after',
    status: 'applied',
    timestamp: input.timestamp,
  };
}

function rowSummary(rows: ReturnType<typeof transcriptRowsWithTurnChanges>): string[] {
  return rows.map((row) =>
    row.kind === 'message'
      ? `message:${row.message.id}`
      : `changes:${row.edits.map((item) => item.id).join(',')}`,
  );
}

function check(label: string, actual: string[], expected: string[]): void {
  assert.deepEqual(actual, expected, label);
  console.log(`ok - ${label}`);
}

function main(): void {
  {
    // Given: two completed turns with explicit turn ids on their transcript rows.
    const messages = [
      textMessage({ id: 'u1', role: 'user', timestamp: 100, turnId: 'turn-1' }),
      textMessage({ id: 'a1', role: 'assistant', timestamp: 200, turnId: 'turn-1' }),
      textMessage({ id: 'u2', role: 'user', timestamp: 300, turnId: 'turn-2' }),
      textMessage({ id: 'a2', role: 'assistant', timestamp: 400, turnId: 'turn-2' }),
    ];
    const edits = [
      edit({ id: 'e1', turnId: 'turn-1', timestamp: 180 }),
      edit({ id: 'e2', turnId: 'turn-2', timestamp: 360 }),
    ];

    // When: rows are built for rendering.
    const rows = transcriptRowsWithTurnChanges(messages, edits);

    // Then: each change block sits directly after the turn that produced it.
    check('explicit turn edits render after their producing turn', rowSummary(rows), [
      'message:u1',
      'message:a1',
      'changes:e1',
      'message:u2',
      'message:a2',
      'changes:e2',
    ]);
  }

  {
    // Given: a legacy saved transcript whose messages predate message turn ids.
    const messages = [
      textMessage({ id: 'u1', role: 'user', timestamp: 100 }),
      textMessage({ id: 'a1', role: 'assistant', timestamp: 200 }),
      textMessage({ id: 'u2', role: 'user', timestamp: 300 }),
      textMessage({ id: 'a2', role: 'assistant', timestamp: 400 }),
    ];
    const edits = [edit({ id: 'legacy-edit', turnId: 'turn-old', timestamp: 220 })];

    // When: rows are built for rendering.
    const rows = transcriptRowsWithTurnChanges(messages, edits);

    // Then: timestamp boundaries keep the legacy edit out of the latest live edge.
    check('legacy edits use timestamp turn boundaries', rowSummary(rows), [
      'message:u1',
      'message:a1',
      'changes:legacy-edit',
      'message:u2',
      'message:a2',
    ]);
  }

  {
    // Given: unresolved edits from a prior reset do not match the visible turn.
    const messages = [
      textMessage({ id: 'u2', role: 'user', timestamp: 300, turnId: 'turn-2' }),
      textMessage({ id: 'a2', role: 'assistant', timestamp: 400, turnId: 'turn-2' }),
    ];
    const edits = [edit({ id: 'orphaned-edit', turnId: 'turn-1', timestamp: 100 })];

    // When: rows are built for rendering.
    const rows = transcriptRowsWithTurnChanges(messages, edits);

    // Then: unmatched edits stay visible but are not pinned below newer chat.
    check(
      'unmatched edits render before newer chat rows',
      rowSummary(rows),
      ['changes:orphaned-edit', 'message:u2', 'message:a2'],
    );
  }

  {
    // Given: explicit message turn ids prove this is not a legacy transcript.
    const messages = [
      textMessage({ id: 'u1', role: 'user', timestamp: 100, turnId: 'turn-1' }),
      textMessage({ id: 'a1', role: 'assistant', timestamp: 200, turnId: 'turn-1' }),
    ];
    const edits = [edit({ id: 'late-unmatched-edit', turnId: 'turn-other', timestamp: 500 })];

    // When: an unmatched edit is newer than all visible messages.
    const rows = transcriptRowsWithTurnChanges(messages, edits);

    // Then: it still renders before the transcript, not under an unrelated turn.
    check(
      'late unmatched edits do not attach to explicit turn transcripts',
      rowSummary(rows),
      ['changes:late-unmatched-edit', 'message:u1', 'message:a1'],
    );
  }

  {
    // Given: a legacy transcript with no turn ids and an edit newer than it.
    const messages = [
      textMessage({ id: 'u1', role: 'user', timestamp: 100 }),
      textMessage({ id: 'a1', role: 'assistant', timestamp: 200 }),
    ];
    const edits = [edit({ id: 'late-legacy-orphan', turnId: 'turn-other', timestamp: 500 })];

    // When: rows are built for rendering.
    const rows = transcriptRowsWithTurnChanges(messages, edits);

    // Then: the newer unmatched edit is not pinned below the old transcript.
    check(
      'late legacy unmatched edits render before old transcript rows',
      rowSummary(rows),
      ['changes:late-legacy-orphan', 'message:u1', 'message:a1'],
    );
  }

  {
    // Given: multiple turn-scoped change rows.
    const messages = [
      textMessage({ id: 'u1', role: 'user', timestamp: 100, turnId: 'turn-1' }),
      textMessage({ id: 'a1', role: 'assistant', timestamp: 200, turnId: 'turn-1' }),
      textMessage({ id: 'u2', role: 'user', timestamp: 300, turnId: 'turn-2' }),
      textMessage({ id: 'a2', role: 'assistant', timestamp: 400, turnId: 'turn-2' }),
    ];
    const edits = [
      edit({ id: 'e1', turnId: 'turn-1', timestamp: 180 }),
      edit({ id: 'e2', turnId: 'turn-2', timestamp: 360 }),
    ];

    // When: rows are built for rendering.
    const rows = transcriptRowsWithTurnChanges(messages, edits);

    // Then: slash diff can target the latest change row, not the stale first one.
    assert.equal(latestChangesRowKey(rows), 'changes:turn-2');
    console.log('ok - latest changes row key points at the newest change group');
  }
}

main();
