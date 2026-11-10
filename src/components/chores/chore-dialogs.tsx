'use client';

import { useMemo, useRef, useState } from 'react';
import { format, getDay } from 'date-fns';
import { Edit, Filter, Loader2, PlusCircle, Trash2, X } from 'lucide-react';
import type { ChoreTemplate, Recurrence, Room } from '@/lib/types';
import type { HouseholdPerson } from '@/lib/member-directory';
import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/empty-state';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { MemberAvatar } from '@/components/member-avatar';
import type { ChoreCapabilities } from '@/lib/chores/list';
import { cn } from '@/lib/utils';
import { AssigneeSelect, memberName } from './assignee-select';
import { RecurrenceFields, buildRecurrence, defaultRecurrenceState, recurrenceStateFrom, scheduleText, useRecurrenceState, type RecurrenceErrors } from './recurrence-fields';
import { RoomIcon, roomIcons } from './room-icons';

const MAX_NAME = 120;

/* -------------------------------------------------------------------------- */
/* Rooms                                                                       */
/* -------------------------------------------------------------------------- */

export function ManageRoomsDialog({
  isOpen,
  onOpenChange,
  rooms,
  capabilities,
  onRoomSave,
  onRoomDelete,
  startWithNewRoom = false,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  rooms: Room[];
  capabilities: ChoreCapabilities;
  onRoomSave: (roomData: { name: string; icon: string }, id?: string) => Promise<boolean>;
  onRoomDelete: (id: string) => Promise<void>;
  startWithNewRoom?: boolean;
}) {
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  const [nameError, setNameError] = useState('');
  const [roomToDelete, setRoomToDelete] = useState<Room | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset when the dialog opens (state adjusted during render, not in an effect).
  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    setNameError('');
    setEditingRoom(isOpen && startWithNewRoom && capabilities.canEdit ? { id: '', name: '', icon: 'Home' } : null);
  }

  const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingRoom || saving) return;
    const name = editingRoom.name.trim();
    if (!name) {
      setNameError('Give the room a name.');
      return;
    }
    if (rooms.some(room => room.id !== editingRoom.id && room.name.toLowerCase() === name.toLowerCase())) {
      setNameError('You already have a room with this name.');
      return;
    }
    setSaving(true);
    const saved = await onRoomSave({ name, icon: editingRoom.icon }, editingRoom.id || undefined);
    setSaving(false);
    if (saved) setEditingRoom(null);
  };

  return (
    <>
      <AlertDialog open={!!roomToDelete} onOpenChange={(open) => !open && setRoomToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {roomToDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Chores in the library stop using this room. Chores already on the chart keep their place.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={() => { if (roomToDelete) void onRoomDelete(roomToDelete.id); setRoomToDelete(null); }}>
              Delete Room
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={isOpen} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rooms</DialogTitle>
            <DialogDescription>Rooms group chores on the chart. Every room is optional.</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh] pr-4">
            <div className="space-y-4 py-2">
              {editingRoom ? (
                <form onSubmit={handleSave} className="space-y-4 rounded-lg border p-4" noValidate>
                  <h3 className="font-semibold">{editingRoom.id ? 'Edit room' : 'New room'}</h3>
                  <div className="space-y-2">
                    <Label htmlFor="room-name">Room name</Label>
                    <Input
                      {...fieldErrorProps('room-name', nameError)}
                      maxLength={60}
                      value={editingRoom.name}
                      onChange={(e) => { setEditingRoom({ ...editingRoom, name: e.target.value }); setNameError(''); }}
                    />
                    <FieldError id="room-name">{nameError}</FieldError>
                  </div>
                  <div className="space-y-2">
                    <Label id="room-icon-label">Icon</Label>
                    <div className="grid grid-cols-5 gap-2 sm:grid-cols-7" role="radiogroup" aria-labelledby="room-icon-label">
                      {roomIcons.map(iconName => (
                        <Button
                          key={iconName}
                          type="button"
                          variant="outline"
                          size="icon"
                          role="radio"
                          aria-checked={editingRoom.icon === iconName}
                          aria-label={`${iconName} icon`}
                          className={cn('h-11 w-11', editingRoom.icon === iconName && 'border-primary bg-primary/10 text-primary')}
                          onClick={() => setEditingRoom({ ...editingRoom, icon: iconName })}
                        >
                          <RoomIcon name={iconName} />
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={() => setEditingRoom(null)}>Cancel</Button>
                    <Button type="submit" disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save Room</Button>
                  </div>
                </form>
              ) : (
                <>
                  {capabilities.canEdit && <Button onClick={() => setEditingRoom({ id: '', name: '', icon: 'Home' })}><PlusCircle className="mr-2 h-4 w-4" /> Add Room</Button>}
                  {rooms.length === 0 ? (
                    <EmptyState
                      compact
                      headingLevel={3}
                      title="No rooms yet"
                      description={capabilities.canEdit ? 'Add rooms like Kitchen or Garage to group chores.' : 'Rooms appear here once someone adds them.'}
                    />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Room</TableHead>
                          {(capabilities.canEdit || capabilities.canDelete) && <TableHead className="text-right">Actions</TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rooms.map(room => (
                          <TableRow key={room.id}>
                            <TableCell>
                              <span className="flex items-center gap-2"><RoomIcon name={room.icon} className="h-5 w-5" />{room.name}</span>
                            </TableCell>
                            {(capabilities.canEdit || capabilities.canDelete) && (
                              <TableCell className="text-right">
                                {capabilities.canEdit && <Button variant="ghost" size="icon" aria-label={`Edit ${room.name}`} onClick={() => setEditingRoom(room)}><Edit className="h-4 w-4" /></Button>}
                                {capabilities.canDelete && <Button variant="ghost" size="icon" aria-label={`Delete ${room.name}`} onClick={() => setRoomToDelete(room)}><Trash2 className="h-4 w-4 text-destructive" /></Button>}
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </>
              )}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Room multi-picker (templates)                                               */
/* -------------------------------------------------------------------------- */

function RoomChecklist({
  idPrefix,
  rooms,
  selected,
  onToggle,
  onCreateRoom,
}: {
  idPrefix: string;
  rooms: Room[];
  selected: string[];
  onToggle: (id: string) => void;
  onCreateRoom?: () => void;
}) {
  if (rooms.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        <span>No rooms yet.</span>
        {onCreateRoom && <Button type="button" variant="outline" size="sm" onClick={onCreateRoom}><PlusCircle className="mr-2 h-4 w-4" />Create a room</Button>}
      </div>
    );
  }
  return (
    <div className="grid gap-1 rounded-md border p-2 sm:grid-cols-2">
      {rooms.map(room => (
        <div key={room.id} className="flex items-center gap-2">
          <Checkbox id={`${idPrefix}-${room.id}`} checked={selected.includes(room.id)} onCheckedChange={() => onToggle(room.id)} />
          <Label htmlFor={`${idPrefix}-${room.id}`} className="flex items-center gap-1.5 font-normal"><RoomIcon name={room.icon} className="h-4 w-4" />{room.name}</Label>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Template create/edit                                                        */
/* -------------------------------------------------------------------------- */

export function ChoreTemplateEditDialog({
  chore,
  isNew,
  onSave,
  rooms,
  isOpen,
  onOpenChange,
  capabilities,
  onCreateRoom,
}: {
  chore: ChoreTemplate | null;
  isNew: boolean;
  onSave: (choreData: Partial<ChoreTemplate>, id?: string) => Promise<boolean>;
  rooms: Room[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  capabilities: ChoreCapabilities;
  onCreateRoom?: () => void;
}) {
  const [task, setTask] = useState('');
  const [notes, setNotes] = useState('');
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>([]);
  const [subTasks, setSubTasks] = useState(['']);
  const [errors, setErrors] = useState<{ task?: string; rooms?: string }>({});
  const [saving, setSaving] = useState(false);

  const [openedFor, setOpenedFor] = useState<{ open: boolean; chore: ChoreTemplate | null }>({ open: false, chore: null });
  if (openedFor.open !== isOpen || openedFor.chore !== chore) {
    setOpenedFor({ open: isOpen, chore });
    if (isOpen) {
      setTask(chore?.task || '');
      setNotes(chore?.notes || '');
      setSelectedRoomIds(chore?.roomIds || []);
      setSubTasks(chore?.subTasks && chore.subTasks.length > 0 ? chore.subTasks : ['']);
      setErrors({});
      setSaving(false);
    }
  }

  const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const nextErrors: typeof errors = {};
    if (!task.trim()) nextErrors.task = 'Give the chore a name.';
    // Removing a room deletes that room's open chores, which needs delete permission.
    const removedRooms = (chore?.roomIds || []).filter(id => !selectedRoomIds.includes(id));
    if (!isNew && removedRooms.length > 0 && !capabilities.canDelete) {
      nextErrors.rooms = 'Removing a room also removes its open chores, which your role cannot do.';
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSaving(true);
    const saved = await onSave({
      task: task.trim(),
      notes: notes.trim(),
      roomIds: selectedRoomIds,
      subTasks: subTasks.map(st => st.trim()).filter(Boolean),
    }, chore?.id);
    setSaving(false);
    if (saved) onOpenChange(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? 'New library chore' : 'Edit chore'}</DialogTitle>
          <DialogDescription>{isNew ? 'Save a chore you do often, then assign it whenever you need it.' : `Changes apply to ${chore?.task || 'this chore'} and its open chores.`}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSave} noValidate>
          <div className="grid max-h-[65vh] gap-4 overflow-y-auto py-2 pr-2">
            <div className="space-y-2">
              <Label htmlFor="task-edit">Chore name</Label>
              <Input {...fieldErrorProps('task-edit', errors.task)} maxLength={MAX_NAME} value={task} onChange={e => { setTask(e.target.value); setErrors(p => ({ ...p, task: undefined })); }} />
              <FieldError id="task-edit">{errors.task}</FieldError>
            </div>
            <div className="space-y-2">
              <Label htmlFor="notes-edit">Notes <span className="text-muted-foreground">(optional)</span></Label>
              <Textarea id="notes-edit" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any special instructions..." />
            </div>
            <div className="space-y-2">
              <Label id="template-rooms-label">Rooms <span className="text-muted-foreground">(optional)</span></Label>
              <div aria-labelledby="template-rooms-label" role="group" aria-describedby={errors.rooms ? 'template-rooms-error' : undefined}>
                <RoomChecklist
                  idPrefix="template-room"
                  rooms={rooms}
                  selected={selectedRoomIds}
                  onToggle={(id) => { setSelectedRoomIds(p => p.includes(id) ? p.filter(r => r !== id) : [...p, id]); setErrors(p => ({ ...p, rooms: undefined })); }}
                  onCreateRoom={capabilities.canEdit ? onCreateRoom : undefined}
                />
              </div>
              <FieldError id="template-rooms">{errors.rooms}</FieldError>
            </div>
            <div className="space-y-2">
              <Label>Sub-tasks <span className="text-muted-foreground">(optional)</span></Label>
              <div className="space-y-2">
                {subTasks.map((subTask, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      aria-label={`Sub-task ${index + 1}`}
                      value={subTask}
                      maxLength={MAX_NAME}
                      onChange={(e) => setSubTasks(p => p.map((v, i) => (i === index ? e.target.value : v)))}
                      placeholder={`Sub-task #${index + 1}`}
                    />
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove sub-task ${subTask || index + 1}`} onClick={() => setSubTasks(p => (p.length > 1 ? p.filter((_, i) => i !== index) : ['']))}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setSubTasks(p => [...p, ''])}><PlusCircle className="mr-2 h-4 w-4" /> Add Sub-task</Button>
            </div>
          </div>
          <DialogFooter className="pt-4">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Assign library chores                                                       */
/* -------------------------------------------------------------------------- */

export type AssignSchedule =
  | { type: 'onetime'; dueDate: Date }
  | { type: 'recurring'; recurrence: Omit<Recurrence, 'assignedToEmail'> };

export function AssignChoresDialog({
  isOpen,
  onOpenChange,
  users,
  rooms,
  templatesToAssign,
  currentUserUid,
  capabilities,
  onAssign,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  users: HouseholdPerson[];
  rooms: Room[];
  templatesToAssign: ChoreTemplate[];
  currentUserUid: string;
  capabilities: ChoreCapabilities;
  onAssign: (assignment: { assigneeUid: string; roomIds: string[] }, schedule: AssignSchedule) => Promise<boolean>;
}) {
  const [isRecurring, setIsRecurring] = useState(false);
  const [assigneeUid, setAssigneeUid] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<{ assignee?: string; rooms?: string; dueDate?: string } & RecurrenceErrors>({});
  const [saving, setSaving] = useState(false);
  const { state: recurrence, setState: setRecurrence, update: updateRecurrence } = useRecurrenceState();

  // One-time assignment needs chores.create; recurring updates the template (chores.edit).
  const canOneTime = capabilities.canCreate;
  const canRecurring = capabilities.canEdit;
  const assignableUsers = capabilities.canAssign ? users : users.filter(u => u.uid === currentUserUid);

  const roomsById = useMemo(() => new Map(rooms.map(room => [room.id, room])), [rooms]);
  const commonRooms = useMemo(() => {
    if (templatesToAssign.length === 0) return [];
    const counts = new Map<string, number>();
    templatesToAssign.flatMap(t => t.roomIds || []).forEach(id => counts.set(id, (counts.get(id) || 0) + 1));
    return [...counts.entries()].filter(([, n]) => n === templatesToAssign.length).map(([id]) => roomsById.get(id)).filter(Boolean) as Room[];
  }, [templatesToAssign, roomsById]);

  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setIsRecurring(!canOneTime && canRecurring);
      setAssigneeUid(assignableUsers.some(u => u.uid === currentUserUid) ? currentUserUid : (assignableUsers.length === 1 ? assignableUsers[0].uid : ''));
      setDueDate(format(new Date(), 'yyyy-MM-dd'));
      setRecurrence({ ...defaultRecurrenceState(), daysOfWeek: [String(getDay(new Date()))] });
      setSelectedRoomIds(commonRooms.map(r => r.id));
      setErrors({});
      setSaving(false);
    }
  }

  const title = templatesToAssign.length === 1 ? `Assign ${templatesToAssign[0].task}` : `Assign ${templatesToAssign.length} chores`;

  const handleAssign = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const nextErrors: typeof errors = {};
    if (!assigneeUid) nextErrors.assignee = 'Choose who does it.';
    if (commonRooms.length > 0 && selectedRoomIds.length === 0) nextErrors.rooms = 'Pick at least one room.';
    let schedule: AssignSchedule | null = null;
    if (isRecurring) {
      const built = buildRecurrence(recurrence);
      if ('errors' in built) Object.assign(nextErrors, built.errors);
      else schedule = { type: 'recurring', recurrence: built.recurrence };
    } else if (!dueDate) {
      nextErrors.dueDate = 'Pick a due date.';
    } else {
      schedule = { type: 'onetime', dueDate: new Date(`${dueDate}T12:00:00`) };
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !schedule) return;
    setSaving(true);
    const ok = await onAssign({ assigneeUid, roomIds: selectedRoomIds }, schedule);
    setSaving(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Choose who does it and when.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleAssign} noValidate>
          <div className="grid max-h-[65vh] gap-4 overflow-y-auto py-2 pr-2">
            <div className="space-y-2">
              <Label htmlFor="assign-assignee">Assign to</Label>
              <AssigneeSelect
                id="assign-assignee"
                users={assignableUsers}
                value={assigneeUid}
                onChange={(uid) => { setAssigneeUid(uid); setErrors(p => ({ ...p, assignee: undefined })); }}
                invalid={Boolean(errors.assignee)}
                describedBy={errors.assignee ? 'assign-assignee-error' : undefined}
              />
              <FieldError id="assign-assignee">{errors.assignee}</FieldError>
            </div>

            {commonRooms.length > 0 && (
              <div className="space-y-2">
                <Label id="assign-rooms-label">Rooms</Label>
                <div role="group" aria-labelledby="assign-rooms-label" aria-describedby={errors.rooms ? 'assign-rooms-error' : undefined}>
                  <RoomChecklist idPrefix="assign-room" rooms={commonRooms} selected={selectedRoomIds} onToggle={(id) => { setSelectedRoomIds(p => p.includes(id) ? p.filter(r => r !== id) : [...p, id]); setErrors(p => ({ ...p, rooms: undefined })); }} />
                </div>
                <FieldError id="assign-rooms">{errors.rooms}</FieldError>
              </div>
            )}

            {canOneTime && canRecurring && (
              <RadioGroup aria-label="Schedule" value={isRecurring ? 'recurring' : 'onetime'} onValueChange={(val) => setIsRecurring(val === 'recurring')} className="flex gap-3">
                <Label htmlFor="onetime" className="flex flex-1 cursor-pointer items-center gap-2 rounded-md border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/10">
                  <RadioGroupItem value="onetime" id="onetime" /> One time
                </Label>
                <Label htmlFor="recurring" className="flex flex-1 cursor-pointer items-center gap-2 rounded-md border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/10">
                  <RadioGroupItem value="recurring" id="recurring" /> Repeats
                </Label>
              </RadioGroup>
            )}

            {!isRecurring ? (
              <div className="space-y-2">
                <Label htmlFor="assign-due-date">Due date</Label>
                <Input type="date" {...fieldErrorProps('assign-due-date', errors.dueDate)} value={dueDate} onChange={(e) => { setDueDate(e.target.value); setErrors(p => ({ ...p, dueDate: undefined })); }} />
                <FieldError id="assign-due-date">{errors.dueDate}</FieldError>
              </div>
            ) : (
              <div className="rounded-lg border p-4">
                <RecurrenceFields idPrefix="assign" state={recurrence} update={(k, v) => { updateRecurrence(k, v); setErrors(p => ({ ...p, daysOfWeek: undefined, biweeklyStartDate: undefined })); }} errors={errors} />
              </div>
            )}
          </div>
          <DialogFooter className="pt-4">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Assign</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Chore library                                                               */
/* -------------------------------------------------------------------------- */

export function ChoreLibraryDialog({
  isOpen,
  onOpenChange,
  choreTemplates,
  rooms,
  capabilities,
  onChoreTemplateSave,
  onChoreTemplateDelete,
  onAssignChores,
  onCreateRoom,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  choreTemplates: ChoreTemplate[];
  rooms: Room[];
  capabilities: ChoreCapabilities;
  onChoreTemplateSave: (choreData: Partial<ChoreTemplate>, id?: string) => Promise<boolean>;
  onChoreTemplateDelete: (id: string) => Promise<void>;
  onAssignChores: (templates: ChoreTemplate[]) => void;
  onCreateRoom: () => void;
}) {
  const [editing, setEditing] = useState<{ template: ChoreTemplate | null } | null>(null);
  const [templateToDelete, setTemplateToDelete] = useState<ChoreTemplate | null>(null);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>([]);
  const [filterRoomId, setFilterRoomId] = useState<string>('all');
  const canAssign = capabilities.canCreate || capabilities.canEdit;

  const roomsById = useMemo(() => new Map(rooms.map(room => [room.id, room])), [rooms]);
  const filteredTemplates = useMemo(() => {
    if (filterRoomId === 'all') return choreTemplates;
    if (filterRoomId === 'none') return choreTemplates.filter(t => !t.roomIds || t.roomIds.length === 0);
    return choreTemplates.filter(t => t.roomIds?.includes(filterRoomId));
  }, [choreTemplates, filterRoomId]);

  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (!isOpen) setSelectedTemplateIds([]);
  }

  return (
    <>
      <ChoreTemplateEditDialog
        isOpen={!!editing}
        onOpenChange={(open) => !open && setEditing(null)}
        chore={editing?.template ?? null}
        isNew={!editing?.template}
        onSave={onChoreTemplateSave}
        rooms={rooms}
        capabilities={capabilities}
        onCreateRoom={onCreateRoom}
      />
      <AlertDialog open={!!templateToDelete} onOpenChange={(open) => !open && setTemplateToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {templateToDelete?.task}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the chore from the library{templateToDelete?.recurrence ? ', stops its repeating schedule' : ''} and deletes its open chores. Completed history stays.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={() => { if (templateToDelete) void onChoreTemplateDelete(templateToDelete.id); setTemplateToDelete(null); }}>
              Delete Chore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={isOpen} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl">
          <DialogHeader className="pr-10 sm:pr-12">
            <div className="flex flex-col items-start justify-between gap-3 md:flex-row md:items-center">
              <div>
                <DialogTitle>Chore library</DialogTitle>
                <DialogDescription>Chores you do often. Tick some and assign them in one go.</DialogDescription>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8">
                    <Filter className="mr-2 h-3 w-3" />
                    {filterRoomId === 'all' ? 'All Rooms' : (filterRoomId === 'none' ? 'No Room' : roomsById.get(filterRoomId)?.name || 'Filter')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>Filter by room</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup value={filterRoomId} onValueChange={setFilterRoomId}>
                    <DropdownMenuRadioItem value="all">All Rooms</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="none">No Room</DropdownMenuRadioItem>
                    {rooms.map(room => (
                      <DropdownMenuRadioItem key={room.id} value={room.id}>
                        <span className="flex items-center gap-2"><RoomIcon name={room.icon} className="h-3 w-3" />{room.name}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </DialogHeader>
          {choreTemplates.length === 0 ? (
            <EmptyState
              kind="chores"
              compact
              headingLevel={3}
              title="Your library is empty"
              description="Save chores you repeat, like taking out the trash, so assigning them takes one tap."
              action={capabilities.canCreate ? { label: 'New library chore', icon: <PlusCircle className="h-4 w-4" />, onClick: () => setEditing({ template: null }) } : undefined}
            />
          ) : (
            <ScrollArea className="max-h-[55vh]">
              <Table>
                <TableHeader>
                  <TableRow>
                    {canAssign && <TableHead className="w-12"><span className="sr-only">Select</span></TableHead>}
                    <TableHead>Chore</TableHead>
                    <TableHead>Rooms</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTemplates.length > 0 ? filteredTemplates.map(template => (
                    <TableRow key={template.id}>
                      {canAssign && (
                        <TableCell>
                          <Checkbox
                            aria-label={`Select ${template.task}`}
                            checked={selectedTemplateIds.includes(template.id)}
                            onCheckedChange={() => setSelectedTemplateIds(p => p.includes(template.id) ? p.filter(id => id !== template.id) : [...p, template.id])}
                          />
                        </TableCell>
                      )}
                      <TableCell className="font-medium">
                        {template.task}
                        {template.recurrence && <span className="block text-xs font-normal text-muted-foreground">{scheduleText(template.recurrence)}</span>}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {(template.roomIds || []).map(roomId => (
                            <span key={roomId} className="rounded-full bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">{roomsById.get(roomId)?.name || 'Removed room'}</span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        {capabilities.canEdit && <Button variant="ghost" size="icon" aria-label={`Edit ${template.task}`} className="h-9 w-9" onClick={() => setEditing({ template })}><Edit className="h-4 w-4" /></Button>}
                        {capabilities.canDelete && <Button variant="ghost" size="icon" aria-label={`Delete ${template.task}`} className="h-9 w-9" onClick={() => setTemplateToDelete(template)}><Trash2 className="h-4 w-4 text-destructive" /></Button>}
                      </TableCell>
                    </TableRow>
                  )) : (
                    <TableRow>
                      <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No chores in this room.</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
          <DialogFooter className="flex-col justify-between gap-2 pt-4 sm:flex-row">
            {capabilities.canCreate && choreTemplates.length > 0 ? (
              <Button variant="outline" onClick={() => setEditing({ template: null })} className="w-full sm:w-auto"><PlusCircle className="mr-2 h-4 w-4" /> New library chore</Button>
            ) : <span />}
            <div className="flex w-full items-center gap-2 sm:w-auto">
              {canAssign && (
                <Button
                  onClick={() => { onAssignChores(choreTemplates.filter(t => selectedTemplateIds.includes(t.id))); setSelectedTemplateIds([]); }}
                  disabled={selectedTemplateIds.length === 0}
                  className="flex-1 sm:flex-none"
                >
                  Assign ({selectedTemplateIds.length})
                </Button>
              )}
              <Button variant="secondary" onClick={() => onOpenChange(false)} className="flex-1 sm:flex-none">Close</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Repeating chores                                                            */
/* -------------------------------------------------------------------------- */

function EditRecurringTaskDialog({
  isOpen,
  onOpenChange,
  chore,
  users,
  currentUserUid,
  capabilities,
  onSave,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  chore: ChoreTemplate | null;
  users: HouseholdPerson[];
  currentUserUid: string;
  capabilities: ChoreCapabilities;
  onSave: (choreId: string, assigneeUid: string, recurrence: Omit<Recurrence, 'assignedToEmail'>) => Promise<boolean>;
}) {
  const [assigneeUid, setAssigneeUid] = useState('');
  const [errors, setErrors] = useState<{ assignee?: string } & RecurrenceErrors>({});
  const [saving, setSaving] = useState(false);
  const { state, setState, update } = useRecurrenceState();
  const assignableUsers = capabilities.canAssign ? users : users.filter(u => u.uid === currentUserUid || u.uid === chore?.assignedToUid);

  const [loadedChore, setLoadedChore] = useState<ChoreTemplate | null>(null);
  if (chore !== loadedChore) {
    setLoadedChore(chore);
    if (chore) {
      // `assignedToUid` was resolved on load (uid, or the email of older templates).
      setAssigneeUid(chore.assignedToUid || '');
      setState(recurrenceStateFrom(chore.recurrence));
      setErrors({});
      setSaving(false);
    }
  }

  const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chore || saving) return;
    const nextErrors: typeof errors = {};
    if (!assigneeUid) nextErrors.assignee = 'Choose who does it.';
    const built = buildRecurrence(state);
    if ('errors' in built) Object.assign(nextErrors, built.errors);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || 'errors' in built) return;
    setSaving(true);
    const ok = await onSave(chore.id, assigneeUid, built.recurrence);
    setSaving(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit repeating chore</DialogTitle>
          <DialogDescription>{chore?.task}. Open chores from the old schedule are replaced.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSave} noValidate>
          <div className="grid max-h-[65vh] gap-4 overflow-y-auto py-2 pr-2">
            <div className="space-y-2">
              <Label htmlFor="recurring-assignee">Assign to</Label>
              <AssigneeSelect id="recurring-assignee" users={assignableUsers} value={assigneeUid} onChange={(uid) => { setAssigneeUid(uid); setErrors(p => ({ ...p, assignee: undefined })); }} invalid={Boolean(errors.assignee)} describedBy={errors.assignee ? 'recurring-assignee-error' : undefined} />
              <FieldError id="recurring-assignee">{errors.assignee}</FieldError>
            </div>
            <div className="rounded-lg border p-4">
              <RecurrenceFields idPrefix="edit" state={state} update={(k, v) => { update(k, v); setErrors(p => ({ ...p, daysOfWeek: undefined, biweeklyStartDate: undefined })); }} errors={errors} />
            </div>
          </div>
          <DialogFooter className="pt-4">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save Changes</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RecurringChoresDialog({
  isOpen,
  onOpenChange,
  recurringChores,
  users,
  currentUserUid,
  capabilities,
  onUpdate,
  onDelete,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  recurringChores: ChoreTemplate[];
  users: HouseholdPerson[];
  currentUserUid: string;
  capabilities: ChoreCapabilities;
  onUpdate: (choreId: string, assigneeUid: string, recurrence: Omit<Recurrence, 'assignedToEmail'>) => Promise<boolean>;
  onDelete: (choreId: string) => Promise<void>;
}) {
  const [choreToEdit, setChoreToEdit] = useState<ChoreTemplate | null>(null);
  const [choreToDelete, setChoreToDelete] = useState<ChoreTemplate | null>(null);
  const usersByUid = useMemo(() => new Map(users.map(u => [u.uid, u])), [users]);
  // Changing or stopping a schedule rewrites the template and removes its open chores.
  const canManage = capabilities.canEdit && capabilities.canDelete;

  return (
    <>
      <EditRecurringTaskDialog isOpen={!!choreToEdit} onOpenChange={(open) => !open && setChoreToEdit(null)} chore={choreToEdit} users={users} currentUserUid={currentUserUid} capabilities={capabilities} onSave={onUpdate} />
      <AlertDialog open={!!choreToDelete} onOpenChange={(open) => !open && setChoreToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop repeating {choreToDelete?.task}?</AlertDialogTitle>
            <AlertDialogDescription>Its open chores are removed and no new ones are created. The chore stays in the library and completed history stays.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={() => { if (choreToDelete) void onDelete(choreToDelete.id); setChoreToDelete(null); }}>
              Stop Repeating
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={isOpen} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Repeating chores</DialogTitle>
            <DialogDescription>Who does what, and how often.</DialogDescription>
          </DialogHeader>
          {recurringChores.length === 0 ? (
            <EmptyState kind="chores" compact headingLevel={3} title="Nothing repeats yet" description="Choose Repeats when you add a chore and it shows up on schedule by itself." />
          ) : (
            <ScrollArea className="mt-2 max-h-[60vh]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Chore</TableHead>
                    <TableHead>Assigned to</TableHead>
                    <TableHead>Schedule</TableHead>
                    {canManage && <TableHead className="text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recurringChores.map(chore => {
                    const user = usersByUid.get(chore.assignedToUid || '');
                    return (
                      <TableRow key={chore.id}>
                        <TableCell className="font-medium">{chore.task}</TableCell>
                        <TableCell>
                          <span className="flex items-center gap-2">
                            {user && <MemberAvatar uid={user.uid} name={memberName(user)} photoUrl={user.avatarUrl} size="sm" decorative />}
                            {user ? memberName(user) : 'Unassigned'}
                          </span>
                        </TableCell>
                        <TableCell>{scheduleText(chore.recurrence)}</TableCell>
                        {canManage && (
                          <TableCell className="whitespace-nowrap text-right">
                            <Button variant="ghost" size="icon" aria-label={`Edit repeating chore ${chore.task}`} onClick={() => setChoreToEdit(chore)}><Edit className="h-4 w-4" /></Button>
                            <Button variant="ghost" size="icon" aria-label={`Stop repeating ${chore.task}`} onClick={() => setChoreToDelete(chore)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Add chore (quick add)                                                       */
/* -------------------------------------------------------------------------- */

export type AddChoreInput = {
  task: string;
  notes: string;
  roomId: string;
  assigneeUid: string;
} & ({ repeat: false; dueDate: string } | { repeat: true; recurrence: Omit<Recurrence, 'assignedToEmail'> });

/**
 * One dialog for "take out the trash": name, who, when (one time or repeating),
 * and an optional room. Replaces the seven-step library → assign flow for new
 * chores; the library is still there for chores you reuse.
 */
export function AddChoreDialog({
  isOpen,
  onOpenChange,
  users,
  rooms,
  currentUserUid,
  capabilities,
  onCreateRoom,
  onCreate,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  users: HouseholdPerson[];
  rooms: Room[];
  currentUserUid: string;
  capabilities: ChoreCapabilities;
  onCreateRoom: () => void;
  onCreate: (input: AddChoreInput) => Promise<boolean>;
}) {
  const [task, setTask] = useState('');
  const [notes, setNotes] = useState('');
  const [roomId, setRoomId] = useState('general');
  const [assigneeUid, setAssigneeUid] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [dueDate, setDueDate] = useState('');
  const [errors, setErrors] = useState<{ task?: string; assignee?: string; dueDate?: string } & RecurrenceErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const { state: recurrence, setState: setRecurrence, update: updateRecurrence } = useRecurrenceState();
  const assignableUsers = capabilities.canAssign ? users : users.filter(u => u.uid === currentUserUid);

  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setTask('');
      setNotes('');
      setRoomId('general');
      setAssigneeUid(assignableUsers.some(u => u.uid === currentUserUid) ? currentUserUid : '');
      setRepeat(false);
      setDueDate(format(new Date(), 'yyyy-MM-dd'));
      setRecurrence({ ...defaultRecurrenceState(), daysOfWeek: [String(getDay(new Date()))], dayOfMonth: Math.min(new Date().getDate(), 28) });
      setErrors({});
      setIsSubmitting(false);
    }
  }
  // A room that no longer exists falls back to "No room".
  const effectiveRoomId = roomId !== 'general' && !rooms.some(room => room.id === roomId) ? 'general' : roomId;

  const clear = (key: keyof typeof errors) => setErrors(previous => ({ ...previous, [key]: undefined }));

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;
    const nextErrors: typeof errors = {};
    if (!task.trim()) nextErrors.task = 'Give the chore a name.';
    if (!assigneeUid) nextErrors.assignee = 'Choose who does it.';
    let input: AddChoreInput | null = null;
    const base = { task: task.trim(), notes: notes.trim(), roomId: effectiveRoomId, assigneeUid };
    if (repeat) {
      const built = buildRecurrence(recurrence);
      if ('errors' in built) Object.assign(nextErrors, built.errors);
      else input = { ...base, repeat: true, recurrence: built.recurrence };
    } else if (!dueDate) {
      nextErrors.dueDate = 'Pick a due date.';
    } else {
      input = { ...base, repeat: false, dueDate };
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !input) {
      if (nextErrors.task) nameRef.current?.focus();
      return;
    }
    submittingRef.current = true;
    setIsSubmitting(true);
    const created = await onCreate(input);
    submittingRef.current = false;
    setIsSubmitting(false);
    if (created) onOpenChange(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !isSubmitting && onOpenChange(open)}>
      <DialogContent className="flex max-h-[90dvh] max-w-xl flex-col overflow-hidden p-0">
        <DialogHeader className="px-6 pb-0 pr-10 pt-6">
          <DialogTitle>Add chore</DialogTitle>
          <DialogDescription>Name it, pick who does it and when. That&apos;s it.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col" noValidate>
          <div className="min-h-0 flex-1 touch-pan-y space-y-4 overflow-y-auto overscroll-contain px-6 pb-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="add-chore-name">Chore</Label>
              <Input
                ref={nameRef}
                {...fieldErrorProps('add-chore-name', errors.task)}
                maxLength={MAX_NAME}
                placeholder="Take out the trash"
                value={task}
                onChange={(event) => { setTask(event.target.value); clear('task'); }}
              />
              <FieldError id="add-chore-name">{errors.task}</FieldError>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="add-chore-assignee">Who</Label>
                <AssigneeSelect
                  id="add-chore-assignee"
                  users={assignableUsers}
                  value={assigneeUid}
                  onChange={(uid) => { setAssigneeUid(uid); clear('assignee'); }}
                  invalid={Boolean(errors.assignee)}
                  describedBy={errors.assignee ? 'add-chore-assignee-error' : undefined}
                />
                <FieldError id="add-chore-assignee">{errors.assignee}</FieldError>
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-chore-room">Room <span className="text-muted-foreground">(optional)</span></Label>
                <Select value={effectiveRoomId} onValueChange={setRoomId}>
                  <SelectTrigger id="add-chore-room"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="general">No room</SelectItem>
                    {rooms.map(room => <SelectItem key={room.id} value={room.id}>{room.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                {rooms.length === 0 && (
                  <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    No rooms yet.
                    {capabilities.canEdit && <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={onCreateRoom}>Create a room</Button>}
                  </p>
                )}
              </div>
            </div>
            <RadioGroup aria-label="When" value={repeat ? 'repeat' : 'once'} onValueChange={(v) => { setRepeat(v === 'repeat'); clear('dueDate'); }} className="flex gap-3">
              <Label htmlFor="add-chore-once" className="flex flex-1 cursor-pointer items-center gap-2 rounded-md border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/10">
                <RadioGroupItem value="once" id="add-chore-once" /> One time
              </Label>
              <Label htmlFor="add-chore-repeat" className="flex flex-1 cursor-pointer items-center gap-2 rounded-md border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/10">
                <RadioGroupItem value="repeat" id="add-chore-repeat" /> Repeats
              </Label>
            </RadioGroup>
            {!repeat ? (
              <div className="space-y-2">
                <Label htmlFor="add-chore-due-date">Due date</Label>
                <Input type="date" {...fieldErrorProps('add-chore-due-date', errors.dueDate)} value={dueDate} onChange={(event) => { setDueDate(event.target.value); clear('dueDate'); }} />
                <FieldError id="add-chore-due-date">{errors.dueDate}</FieldError>
              </div>
            ) : (
              <div className="space-y-2 rounded-lg border p-4">
                <RecurrenceFields idPrefix="add-chore" state={recurrence} update={(k, v) => { updateRecurrence(k, v); clear('daysOfWeek'); clear('biweeklyStartDate'); }} errors={errors} />
                <p className="text-xs text-muted-foreground">The first one shows up on the next matching day.</p>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="add-chore-notes">Notes <span className="text-muted-foreground">(optional)</span></Label>
              <Textarea id="add-chore-notes" value={notes} onChange={(event) => setNotes(event.target.value)} className="min-h-20 resize-none" />
            </div>
          </div>
          <DialogFooter className="border-t px-6 py-4">
            <Button type="button" variant="secondary" disabled={isSubmitting} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Chore
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
