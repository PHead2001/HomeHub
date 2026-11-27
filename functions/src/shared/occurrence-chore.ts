// The chore document upkeep generates for one occurrence of a repeating
// chore. Shared by the hourly generator (reminders.ts) and the web app's
// "move a planned day" action (audit CA-15), so a day created early has
// exactly the shape, id and occurrence key upkeep would have given it.
import {zonedMidnightIso} from "./calendar";
import {assigneeFields} from "./assignee";
import {choreOccurrenceKey, occurrenceChoreId} from "./ids";

export type OccurrenceTemplate = {
  task?: unknown;
  notes?: unknown;
  subTasks?: unknown;
};

export type OccurrencePerson = {uid: string; displayName?: string | null};

export type GeneratedChore = {
  task: unknown;
  assignedToUid: string;
  assignedToDisplayName: string;
  dueDate: string;
  isCompleted: false;
  notes: unknown;
  subTasks: unknown;
  completedSubTasks: string[];
  templateId: string;
  originalDueDate: string;
  occurrenceKey: string;
  roomIds: string[];
};

/**
 * Id and fields of a generated occurrence. `day` is the occurrence's own day
 * (its identity); `dueDay` is where it is due, the same unless it was moved
 * before it was generated (CA-15).
 * @param {object} input Template, template id, person, room, days and zone.
 * @return {{id: string, data: GeneratedChore}} Document id and fields.
 */
export const generatedOccurrence = (input: {
  template: OccurrenceTemplate;
  templateId: string;
  person: OccurrencePerson;
  roomId: string;
  day: string;
  dueDay?: string;
  timeZone: string;
}): {id: string; data: GeneratedChore} => {
  const {template, templateId, person, roomId, day, timeZone} = input;
  const dueDay = input.dueDay ?? day;
  return {
    id: occurrenceChoreId(templateId, roomId, day),
    data: {
      task: template.task,
      ...assigneeFields({uid: person.uid}),
      assignedToDisplayName: person.displayName || "Member",
      dueDate: zonedMidnightIso(dueDay, timeZone),
      isCompleted: false,
      notes: template.notes || "",
      subTasks: template.subTasks || [],
      completedSubTasks: [],
      templateId,
      originalDueDate: dueDay,
      occurrenceKey: choreOccurrenceKey(templateId, roomId, day),
      roomIds: roomId === "general" ? [] : [roomId],
    },
  };
};
