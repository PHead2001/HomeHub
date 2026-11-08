'use server';

import { executeAuthorizedAiAction, type AiActionContext } from '@/ai/action-auth';
import type { AiActionResult } from '@/ai/errors';
import type { HouseholdPermission } from '@/lib/types';
import {
  parseCommandFlow,
  type ParseCommandInput as TaskInput,
  type ParseCommandKind,
  type ParseCommandOutput as TaskOutput,
} from '@/ai/tasks/parse-command';

export type ParseCommandInput = TaskInput;
export type ParseCommandOutput = TaskOutput;

/** The permission each quick-add kind needs, as in the palette and the module screens. */
const KIND_PERMISSION: Record<ParseCommandKind, HouseholdPermission> = {
  chore: 'chores.create',
  maintenance: 'maintenance.createLogs',
  shopping: 'shopping.edit',
  feeding: 'pets.addLogs',
};

/**
 * Reads a quick-add sentence with AI (command palette fallback). Verifies the
 * Firebase identity and household membership first; the member needs at least one
 * quick-add permission, and the model may only answer with kinds the member's own
 * verified permissions allow. Takes one daily AI request (the shared quota), is
 * rate limited per member, and writes nothing.
 */
export async function parseCommand(
  input: ParseCommandInput,
  context: AiActionContext
): Promise<AiActionResult<ParseCommandOutput>> {
  return executeAuthorizedAiAction({
    context,
    input,
    permission: Object.values(KIND_PERMISSION),
    flowName: 'command-parse',
    maxRequestsPerMinute: 20,
    task: user => parseCommandFlow(
      input,
      (Object.keys(KIND_PERMISSION) as ParseCommandKind[]).filter(kind => user.permissions[KIND_PERMISSION[kind]]),
    ),
  });
}
