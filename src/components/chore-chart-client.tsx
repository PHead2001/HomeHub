'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PlusCircle, Trash2, Edit, Home, MoreVertical, X, Calendar as CalendarIcon, BookUser, Repeat, User as UserIcon, ChevronDown, Filter } from 'lucide-react';
import type { LucideIcon, LucideProps } from 'lucide-react';
import type { Chore, User as HomeHubUser, ChoreTemplate, Room, Recurrence } from '@/lib/types';
import { format, addDays, parseISO, add, sub, isPast, isToday, startOfToday, isAfter, getDay, endOfToday } from 'date-fns';
import { Skeleton } from './ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import { collection, query, getDocs, doc, updateDoc, deleteDoc, where, setDoc, writeBatch, runTransaction, getDoc } from 'firebase/firestore';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { stableSlugify, cn } from '@/lib/utils';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { ScrollArea } from './ui/scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Textarea } from './ui/textarea';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';
import { buttonVariants } from './ui/button';
import { Calendar } from './ui/calendar';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { Switch } from './ui/switch';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuLabel, DropdownMenuSeparator } from './ui/dropdown-menu';
import * as LucideIcons from 'lucide-react';

const roomIcons = ["Home", "BedDouble", "Bath", "Sofa", "Utensils", "Microwave", "Refrigerator", "WashingMachine", "Car", "Bike", "TreeDeciduous", "Warehouse", "Armchair", "Tv", "Gamepad2", "Baby", "Dog", "Cat", "Hammer", "Paintbrush" ];

type LucideExport = typeof LucideIcons[keyof typeof LucideIcons];

const isLucideIcon = (icon: LucideExport): icon is LucideIcon => typeof icon === 'function';

const getLucideIcon = (name: string, fallback: LucideIcon): LucideIcon => {
    const icon = LucideIcons[name as keyof typeof LucideIcons];
    return isLucideIcon(icon) ? icon : fallback;
};

const renderIcon = (name: string, props: LucideProps = {}) => {
    const Icon = getLucideIcon(name, Home);
    return <Icon {...props} />;
}

function ManageRoomsDialog({
    isOpen,
    onOpenChange,
    rooms,
    onRoomSave,
    onRoomDelete,
}: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    rooms: Room[];
    onRoomSave: (roomData: { name: string, icon: string }, id?: string) => Promise<void>;
    onRoomDelete: (id: string) => Promise<void>;
}) {
    const [editingRoom, setEditingRoom] = useState<Room | null>(null);

    const openEditForm = (room?: Room) => {
        setEditingRoom(room || { id: '', name: '', icon: 'Home' });
    }

    const closeEditForm = () => {
        setEditingRoom(null);
    }
    
    const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (editingRoom) {
            await onRoomSave({ name: editingRoom.name, icon: editingRoom.icon }, editingRoom.id || undefined);
            closeEditForm();
        }
    }

    useEffect(() => {
        if (!isOpen) {
            closeEditForm();
        }
    }, [isOpen]);
    
    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Manage Rooms</DialogTitle>
                    <DialogDescription>Add, edit, or delete rooms for chore assignment.</DialogDescription>
                </DialogHeader>
                <ScrollArea className="max-h-[60vh] pr-4">
                    <div className="py-4 space-y-4">
                        {editingRoom ? (
                            <form onSubmit={handleSave} className="space-y-4 p-4 border rounded-lg">
                                <h3 className="font-semibold">{editingRoom.id ? 'Edit Room' : 'Add New Room'}</h3>
                                <Input 
                                    placeholder="New room name..."
                                    value={editingRoom.name}
                                    onChange={(e) => setEditingRoom({...editingRoom, name: e.target.value})}
                                />
                                <div className="space-y-2">
                                    <Label>Icon</Label>
                                    <div className="grid grid-cols-7 gap-2">
                                        {roomIcons.map(iconName => (
                                            <Button key={iconName} type="button" variant="outline" size="icon"
                                                className={cn("h-12 w-12", editingRoom.icon === iconName && "ring-2 ring-primary")}
                                                onClick={() => setEditingRoom({...editingRoom, icon: iconName})}
                                            >
                                                {renderIcon(iconName)}
                                            </Button>
                                        ))}
                                    </div>
                                </div>
                                <div className="flex justify-end gap-2">
                                    <Button type="button" variant="secondary" onClick={closeEditForm}>Cancel</Button>
                                    <Button type="submit" disabled={!editingRoom.name.trim()}>Save Room</Button>
                                </div>
                            </form>
                        ) : (
                            <>
                                <Button onClick={() => openEditForm()}><PlusCircle className="mr-2"/> Add Room</Button>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Room Name</TableHead>
                                            <TableHead className="text-right">Actions</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {rooms.map(room => (
                                            <TableRow key={room.id}>
                                                <TableCell className="flex items-center gap-2">
                                                    {renderIcon(room.icon, { className: 'h-5 w-5' })}
                                                    {room.name}
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    <Button variant="ghost" size="icon" onClick={() => openEditForm(room)}><Edit className="h-4 w-4"/></Button>
                                                    <Button variant="ghost" size="icon" onClick={() => onRoomDelete(room.id)}><Trash2 className="h-4 w-4 text-destructive"/></Button>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </>
                        )}
                    </div>
                </ScrollArea>
                <DialogFooter>
                    <Button variant="secondary" onClick={() => onOpenChange(false)}>Done</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}


function ChoreTemplateEditDialog({
  chore,
  isNew,
  onSave,
  onDelete,
  rooms,
  isOpen,
  onOpenChange,
}: {
  chore: ChoreTemplate | null;
  isNew: boolean;
  onSave: (choreData: Partial<ChoreTemplate>, id?: string) => void;
  onDelete: (id: string) => void;
  rooms: Room[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
    const [task, setTask] = useState('');
    const [notes, setNotes] = useState('');
    const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>([]);
    const [subTasks, setSubTasks] = useState(['']);

    useEffect(() => {
        if (isOpen) {
            setTask(chore?.task || '');
            setNotes(chore?.notes || '');
            setSelectedRoomIds(chore?.roomIds || []);
            setSubTasks(chore?.subTasks && chore.subTasks.length > 0 ? chore.subTasks : ['']);
        }
    }, [chore, isOpen]);

    const handleRoomSelection = (roomId: string) => {
        setSelectedRoomIds(prev => prev.includes(roomId) ? prev.filter(id => id !== roomId) : [...prev, roomId]);
    }
    
    const handleSubTaskChange = (index: number, value: string) => {
        const newSubTasks = [...subTasks];
        newSubTasks[index] = value;
        setSubTasks(newSubTasks);
    }

    const addSubTask = () => {
        setSubTasks([...subTasks, '']);
    }

    const removeSubTask = (index: number) => {
        const newSubTasks = subTasks.filter((_, i) => i !== index);
        if (newSubTasks.length === 0) {
            setSubTasks(['']);
        } else {
            setSubTasks(newSubTasks);
        }
    }

    const handleSave = () => {
        if (!task) return;
        const finalSubTasks = subTasks.map(st => st.trim()).filter(st => st !== '');
        
        const templateData: Partial<ChoreTemplate> = {
            task,
            notes,
            roomIds: selectedRoomIds,
            subTasks: finalSubTasks,
        };

        onSave(templateData, chore?.id);
        onOpenChange(false);
    };

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{isNew ? 'Create Chore' : 'Edit Chore'}</DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 py-4 max-h-[70vh] overflow-y-auto pr-4">
                    <div className="space-y-4">
                        <Label htmlFor="task-edit">Chore Name</Label>
                        <Input id="task-edit" value={task} onChange={e => setTask(e.target.value)} />
                    </div>
                     <div>
                        <Label htmlFor="notes-edit">Notes (Optional)</Label>
                        <Textarea id="notes-edit" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any special instructions..."/>
                    </div>
                    <div>
                        <Label>Rooms</Label>
                         <Popover>
                            <PopoverTrigger asChild>
                                <Button variant="outline" className="w-full justify-start font-normal">
                                    {selectedRoomIds.length > 0 ? `${selectedRoomIds.length} room(s) selected` : "Select rooms..."}
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0">
                                <div className="space-y-1 p-2">
                                    {rooms.map(room => (
                                        <div key={room.id} className="flex items-center gap-2">
                                            <Checkbox
                                                id={`room-${room.id}`}
                                                checked={selectedRoomIds.includes(room.id)}
                                                onCheckedChange={() => handleRoomSelection(room.id)}
                                            />
                                            <Label htmlFor={`room-${room.id}`}>{room.name}</Label>
                                        </div>
                                    ))}
                                </div>
                            </PopoverContent>
                         </Popover>
                    </div>
                    <div>
                        <Label>Sub-tasks (Optional)</Label>
                        <div className="space-y-2">
                            {subTasks.map((subTask, index) => (
                                <div key={index} className="flex items-center gap-2">
                                    <Input 
                                        value={subTask} 
                                        onChange={(e) => handleSubTaskChange(index, e.target.value)}
                                        placeholder={`Sub-task #${index + 1}`}
                                    />
                                    <Button variant="ghost" size="icon" onClick={() => removeSubTask(index)}>
                                        <X className="h-4 w-4"/>
                                    </Button>
                                </div>
                            ))}
                        </div>
                        <Button variant="outline" size="sm" onClick={addSubTask} className="mt-2">
                            <PlusCircle className="mr-2"/> Add Sub-task
                        </Button>
                    </div>
                </div>
                <DialogFooter className="justify-between">
                    <div>
                        {!isNew && chore && (
                            <Button variant="destructive" onClick={() => { onDelete(chore.id); onOpenChange(false); }}>Delete</Button>
                        )}
                    </div>
                    <div className="flex gap-2">
                         <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
                         <Button onClick={handleSave} disabled={!task}>Save</Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function AssignChoresDialog({
    isOpen,
    onOpenChange,
    users,
    rooms,
    templatesToAssign,
    onAssign,
}: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    users: HomeHubUser[];
    rooms: Room[];
    templatesToAssign: ChoreTemplate[];
    onAssign: (
      assignment: { assignedToEmail: string; roomIds: string[] },
      schedule:
        | { type: 'onetime'; dueDate: Date }
        | { type: 'recurring'; recurrence: Omit<Recurrence, 'assignedToEmail'> }
    ) => void;
}) {
    const [isRecurring, setIsRecurring] = useState(false);
    const [assignedToEmail, setAssignedToEmail] = useState('');
    const [dueDate, setDueDate] = useState<Date | undefined>(new Date());
    const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
    const [excludeWeekends, setExcludeWeekends] = useState(false);
    const [daysOfWeek, setDaysOfWeek] = useState<string[]>([]);
    const [dayOfMonth, setDayOfMonth] = useState<number>(1);
    const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>([]);

    const roomsById = useMemo(() => new Map(rooms.map(room => [room.id, room])), [rooms]);

    const availableRoomsForTemplates = useMemo(() => {
        if (templatesToAssign.length === 0) return [];
        const allRoomIds = templatesToAssign.flatMap(t => t.roomIds || []);
        if (allRoomIds.length === 0) return [];

        const roomCounts = allRoomIds.reduce((acc, id) => {
            acc[id] = (acc[id] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);

        const commonRoomIds = Object.keys(roomCounts).filter(id => roomCounts[id] === templatesToAssign.length);

        return commonRoomIds.map(id => roomsById.get(id)).filter(Boolean) as Room[];
    }, [templatesToAssign, roomsById]);
    
    useEffect(() => {
        if(isOpen) {
            setIsRecurring(false);
            setAssignedToEmail('');
            setDueDate(new Date());
            setFrequency('weekly');
            setExcludeWeekends(false);
            setDaysOfWeek([]);
            setDayOfMonth(1);
            setSelectedRoomIds(availableRoomsForTemplates.map(r => r.id));
        }
    }, [isOpen, availableRoomsForTemplates]);

    const handleAssign = () => {
        if (!assignedToEmail) {
            alert('Please assign a user.');
            return;
        }

        if (availableRoomsForTemplates.length > 0 && selectedRoomIds.length === 0) {
            alert('Please select at least one room for this assignment.');
            return;
        }

        const assignment = { assignedToEmail, roomIds: selectedRoomIds };
        let schedule:
          | { type: 'onetime'; dueDate: Date }
          | { type: 'recurring'; recurrence: Omit<Recurrence, 'assignedToEmail'> };

        if (isRecurring) {
             const recurrence: Omit<Recurrence, 'assignedToEmail'> = {
                frequency,
                interval: 1,
            };
            if (frequency === 'daily') {
                recurrence.dailyOptions = { excludeWeekends };
            }
            if (frequency === 'weekly') {
                if (daysOfWeek.length === 0) {
                    alert('Please select at least one day for weekly recurrence.');
                    return;
                }
                recurrence.weeklyOptions = { daysOfWeek: daysOfWeek.map(Number) };
            }
            if (frequency === 'monthly') {
                recurrence.monthlyOptions = { dayOfMonth };
            }
            schedule = { type: 'recurring' as const, recurrence };
        } else {
             if (!dueDate) {
                alert('Please select a due date for the one-time task.');
                return;
            }
            schedule = { type: 'onetime' as const, dueDate };
        }

        onAssign(assignment, schedule);
        onOpenChange(false);
    }
    
    const handleRoomSelection = (roomId: string) => {
        setSelectedRoomIds(prev => prev.includes(roomId) ? prev.filter(id => id !== roomId) : [...prev, roomId]);
    }

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Assign {templatesToAssign.length} Chore(s)</DialogTitle>
                </DialogHeader>
                 <div className="grid gap-4 py-4 max-h-[70vh] overflow-y-auto pr-4">
                     <div>
                        <Label htmlFor="assignedTo">Assign To</Label>
                        <Select onValueChange={setAssignedToEmail} value={assignedToEmail}>
                            <SelectTrigger><SelectValue placeholder="Select a person" /></SelectTrigger>
                            <SelectContent>{users.map(user => <SelectItem key={user.email} value={user.email}>{user.displayName || user.email}</SelectItem>)}</SelectContent>
                        </Select>
                    </div>

                    {availableRoomsForTemplates.length > 0 && (
                        <div>
                            <Label>Rooms for this assignment</Label>
                             <div className="space-y-1 p-2 border rounded-md">
                                {availableRoomsForTemplates.map(room => (
                                    <div key={room.id} className="flex items-center gap-2">
                                        <Checkbox
                                            id={`assign-room-${room.id}`}
                                            checked={selectedRoomIds.includes(room.id)}
                                            onCheckedChange={() => handleRoomSelection(room.id)}
                                        />
                                        <Label htmlFor={`assign-room-${room.id}`} className="font-normal">{room.name}</Label>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="space-y-4 pt-4 border-t">
                        <Label>Scheduling</Label>
                        <RadioGroup value={isRecurring ? 'recurring' : 'onetime'} onValueChange={(val) => setIsRecurring(val === 'recurring')} className="flex gap-4">
                            <Label htmlFor="onetime" className="flex items-center gap-2 border rounded-md p-3 flex-1 has-[:checked]:border-primary">
                                <RadioGroupItem value="onetime" id="onetime" /> One-time Task
                            </Label>
                            <Label htmlFor="recurring" className="flex items-center gap-2 border rounded-md p-3 flex-1 has-[:checked]:border-primary">
                                <RadioGroupItem value="recurring" id="recurring" /> Recurring Task
                            </Label>
                        </RadioGroup>
                        
                        <div className={cn("space-y-4 p-4 border rounded-lg", !isRecurring ? 'opacity-100' : 'opacity-50 pointer-events-none')}>
                            <h4 className="font-medium">One-time Due Date</h4>
                             <Popover>
                                <PopoverTrigger asChild>
                                    <Button variant={"outline"} className={cn("w-[240px] justify-start text-left font-normal", !dueDate && "text-muted-foreground")} >
                                        <CalendarIcon className="mr-2 h-4 w-4" />
                                        {dueDate ? format(dueDate, "PPP") : <span>Pick a date</span>}
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-auto p-0" align="start">
                                    <Calendar mode="single" selected={dueDate} onSelect={setDueDate} initialFocus />
                                </PopoverContent>
                             </Popover>
                        </div>
                        
                        <div className={cn("space-y-4 p-4 border rounded-lg", isRecurring ? 'opacity-100' : 'opacity-50 pointer-events-none')}>
                             <h4 className="font-medium">Recurring Schedule</h4>
                             <RadioGroup value={frequency} onValueChange={(v) => setFrequency(v as Recurrence['frequency'])} className="flex gap-2">
                                 <Label htmlFor="daily" className="text-xs p-2 border rounded has-[:checked]:border-primary"> <RadioGroupItem value="daily" id="daily" className="mr-1"/> Daily </Label>
                                 <Label htmlFor="weekly" className="text-xs p-2 border rounded has-[:checked]:border-primary"> <RadioGroupItem value="weekly" id="weekly" className="mr-1"/> Weekly </Label>
                                 <Label htmlFor="monthly" className="text-xs p-2 border rounded has-[:checked]:border-primary"> <RadioGroupItem value="monthly" id="monthly" className="mr-1"/> Monthly </Label>
                             </RadioGroup>

                            {frequency === 'daily' && (
                                <RadioGroup value={excludeWeekends ? 'weekdays' : 'all'} onValueChange={(v) => setExcludeWeekends(v === 'weekdays')} className="flex gap-2">
                                    <Label htmlFor="all-days" className="text-xs p-2 border rounded has-[:checked]:border-primary"> <RadioGroupItem value="all" id="all-days" className="mr-1"/> Every Day </Label>
                                    <Label htmlFor="weekdays-only" className="text-xs p-2 border rounded has-[:checked]:border-primary"> <RadioGroupItem value="weekdays" id="weekdays-only" className="mr-1"/> Weekdays Only </Label>
                                </RadioGroup>
                            )}
                            {frequency === 'weekly' && (
                                <ToggleGroup type="multiple" value={daysOfWeek} onValueChange={setDaysOfWeek} className="flex flex-wrap gap-1">
                                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => <ToggleGroupItem key={day} value={String(i)} className="rounded-full">{day}</ToggleGroupItem>)}
                                </ToggleGroup>
                            )}
                            {frequency === 'monthly' && (
                                <div>
                                    <Label>Day of Month</Label>
                                    <Select onValueChange={(v) => setDayOfMonth(Number(v))} value={String(dayOfMonth)}>
                                        <SelectTrigger><SelectValue/></SelectTrigger>
                                        <SelectContent>{Array.from({length: 28}, (_, i) => i + 1).map(d => <SelectItem key={d} value={String(d)}>{d}</SelectItem>)}</SelectContent>
                                    </Select>
                                </div>
                            )}
                        </div>
                    </div>
                 </div>
                 <DialogFooter>
                    <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button onClick={handleAssign}>Assign</Button>
                 </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

function ManageChoresDialog({
    isOpen,
    onOpenChange,
    choreTemplates,
    onChoreTemplateSave,
    onChoreTemplateDelete,
    rooms,
    onAssignChores
}: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    choreTemplates: ChoreTemplate[];
    onChoreTemplateSave: (choreData: Partial<ChoreTemplate>, id?: string) => void;
    onChoreTemplateDelete: (id: string) => void;
    rooms: Room[];
    onAssignChores: (templates: ChoreTemplate[]) => void;
}) {
    const [choreToEdit, setChoreToEdit] = useState<ChoreTemplate | null>(null);
    const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
    const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
    const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>([]);
    const [filterRoomId, setFilterRoomId] = useState<string>('all');

    const roomsById = useMemo(() => new Map(rooms.map(room => [room.id, room])), [rooms]);

    const filteredTemplates = useMemo(() => {
        if (filterRoomId === 'all') return choreTemplates;
        if (filterRoomId === 'none') return choreTemplates.filter(t => !t.roomIds || t.roomIds.length === 0);
        return choreTemplates.filter(t => t.roomIds?.includes(filterRoomId));
    }, [choreTemplates, filterRoomId]);

    const openCreateDialog = () => {
        setChoreToEdit(null);
        setIsCreateDialogOpen(true);
    };

    const openEditDialog = (template: ChoreTemplate) => {
        setChoreToEdit(template);
        setIsEditDialogOpen(true);
    };
    
    const handleAssign = () => {
        const templatesToAssign = choreTemplates.filter(t => selectedTemplateIds.includes(t.id));
        onAssignChores(templatesToAssign);
        setSelectedTemplateIds([]);
    }
    
     const handleSelectTemplate = (templateId: string) => {
        setSelectedTemplateIds(prev =>
            prev.includes(templateId)
                ? prev.filter(id => id !== templateId)
                : [...prev, templateId]
        );
    };

    return (
        <>
            <ChoreTemplateEditDialog
                isOpen={isCreateDialogOpen}
                onOpenChange={setIsCreateDialogOpen}
                chore={null}
                isNew={true}
                onSave={onChoreTemplateSave}
                onDelete={onChoreTemplateDelete}
                rooms={rooms}
            />
            <ChoreTemplateEditDialog
                isOpen={isEditDialogOpen}
                onOpenChange={setIsEditDialogOpen}
                chore={choreToEdit}
                isNew={false}
                onSave={onChoreTemplateSave}
                onDelete={onChoreTemplateDelete}
                rooms={rooms}
            />

            <Dialog open={isOpen} onOpenChange={onOpenChange}>
                <DialogContent className="max-w-3xl">
                    <DialogHeader className="pr-10 sm:pr-12">
                        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                            <div>
                                <DialogTitle>Chores</DialogTitle>
                                <DialogDescription>Create, edit, and assign chore templates.</DialogDescription>
                            </div>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="outline" size="sm" className="h-8">
                                        <Filter className="mr-2 h-3 w-3" /> 
                                        {filterRoomId === 'all' ? 'All Rooms' : (filterRoomId === 'none' ? 'No Room' : rooms.find(r => r.id === filterRoomId)?.name || 'Filter')}
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-56">
                                    <DropdownMenuLabel>Filter by Room</DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuRadioGroup value={filterRoomId} onValueChange={setFilterRoomId}>
                                        <DropdownMenuRadioItem value="all">All Rooms</DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value="none">No Room Assigned</DropdownMenuRadioItem>
                                        {rooms.length > 0 ? rooms.map(room => (
                                            <DropdownMenuRadioItem key={room.id} value={room.id}>
                                                <div className="flex items-center gap-2">
                                                    {renderIcon(room.icon, { className: 'h-3 w-3' })}
                                                    {room.name}
                                                </div>
                                            </DropdownMenuRadioItem>
                                        )) : (
                                            <DropdownMenuItem disabled className="text-center italic">No rooms created yet</DropdownMenuItem>
                                        )}
                                    </DropdownMenuRadioGroup>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    </DialogHeader>
                    <ScrollArea className="max-h-[60vh]">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="w-12"></TableHead>
                                    <TableHead>Task</TableHead>
                                    <TableHead>Rooms</TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filteredTemplates.length > 0 ? filteredTemplates.map(template => (
                                    <TableRow key={template.id}>
                                        <TableCell>
                                            <Checkbox
                                                checked={selectedTemplateIds.includes(template.id)}
                                                onCheckedChange={() => handleSelectTemplate(template.id)}
                                            />
                                        </TableCell>
                                        <TableCell className="font-medium">{template.task}</TableCell>
                                        <TableCell>
                                            <div className="flex flex-wrap gap-1">
                                                {(template.roomIds || []).map(roomId => (
                                                    <span key={roomId} className="text-[10px] bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded-full">
                                                        {roomsById.get(roomId)?.name || '...'}
                                                    </span>
                                                ))}
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEditDialog(template)}><Edit className="h-3.5 w-3.5"/></Button>
                                        </TableCell>
                                    </TableRow>
                                )) : (
                                    <TableRow>
                                        <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                                            {filterRoomId === 'all' ? 'No chore templates created yet.' : 'No chores found for this filter.'}
                                        </TableCell>
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </ScrollArea>
                    <DialogFooter className="justify-between pt-4 gap-2 flex-col sm:flex-row">
                        <Button variant="outline" onClick={openCreateDialog} className="w-full sm:w-auto"><PlusCircle className="mr-2 h-4 w-4"/> Create Chore</Button>
                         <div className="flex items-center gap-2 w-full sm:w-auto">
                             <Button onClick={handleAssign} disabled={selectedTemplateIds.length === 0} className="flex-1 sm:flex-none">Assign ({selectedTemplateIds.length})</Button>
                             <Button variant="secondary" onClick={() => onOpenChange(false)} className="flex-1 sm:flex-none">Close</Button>
                        </div>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

function EditRecurringTaskDialog({
  isOpen,
  onOpenChange,
  chore,
  users,
  onSave,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  chore: ChoreTemplate | null;
  users: HomeHubUser[];
  onSave: (choreId: string, assignedToEmail: string, recurrence: Recurrence) => void;
}) {
    const [assignedToEmail, setAssignedToEmail] = useState('');
    const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
    const [excludeWeekends, setExcludeWeekends] = useState(false);
    const [daysOfWeek, setDaysOfWeek] = useState<string[]>([]);
    const [dayOfMonth, setDayOfMonth] = useState<number>(1);
    
    useEffect(() => {
        if (chore?.recurrence) {
            setAssignedToEmail(chore.assignedToEmail || '');
            const { recurrence } = chore;
            setFrequency(recurrence.frequency);
            setExcludeWeekends(recurrence.dailyOptions?.excludeWeekends || false);
            setDaysOfWeek(recurrence.weeklyOptions?.daysOfWeek.map(String) || []);
            setDayOfMonth(recurrence.monthlyOptions?.dayOfMonth || 1);
        }
    }, [chore]);

    const handleSave = () => {
        if (!chore || !assignedToEmail) {
            alert("Please select a user.");
            return;
        }

        const recurrence: Recurrence = {
            frequency,
            assignedToEmail,
            interval: 1,
        };

        if (frequency === 'daily') {
            recurrence.dailyOptions = { excludeWeekends };
        }
        if (frequency === 'weekly') {
             if (daysOfWeek.length === 0) {
                alert('Please select at least one day for weekly recurrence.');
                return;
            }
            recurrence.weeklyOptions = { daysOfWeek: daysOfWeek.map(Number) };
        }
        if (frequency === 'monthly') {
            recurrence.monthlyOptions = { dayOfMonth };
        }

        onSave(chore.id, assignedToEmail, recurrence);
        onOpenChange(false);
    }
    
    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Edit Recurring Task</DialogTitle>
                     <DialogDescription>{chore?.task}</DialogDescription>
                </DialogHeader>
                 <div className="grid gap-4 py-4 max-h-[70vh] overflow-y-auto pr-4">
                     <div>
                        <Label htmlFor="assignedTo">Assign To</Label>
                        <Select onValueChange={setAssignedToEmail} value={assignedToEmail}>
                            <SelectTrigger><SelectValue placeholder="Select a person" /></SelectTrigger>
                            <SelectContent>{users.map(user => <SelectItem key={user.email} value={user.email}>{user.displayName || user.email}</SelectItem>)}</SelectContent>
                        </Select>
                    </div>

                    <div className={cn("space-y-4 p-4 border rounded-lg")}>
                         <h4 className="font-medium">Recurring Schedule</h4>
                         <RadioGroup value={frequency} onValueChange={(v) => setFrequency(v as Recurrence['frequency'])} className="flex gap-2">
                             <Label htmlFor="edit-daily" className="text-xs p-2 border rounded has-[:checked]:border-primary"> <RadioGroupItem value="daily" id="edit-daily" className="mr-1"/> Daily </Label>
                             <Label htmlFor="edit-weekly" className="text-xs p-2 border rounded has-[:checked]:border-primary"> <RadioGroupItem value="weekly" id="edit-weekly" className="mr-1"/> Weekly </Label>
                             <Label htmlFor="edit-monthly" className="text-xs p-2 border rounded has-[:checked]:border-primary"> <RadioGroupItem value="monthly" id="edit-monthly" className="mr-1"/> Monthly </Label>
                         </RadioGroup>

                        {frequency === 'daily' && (
                            <RadioGroup value={excludeWeekends ? 'weekdays' : 'all'} onValueChange={(v) => setExcludeWeekends(v === 'weekdays')} className="flex gap-2">
                                <Label htmlFor="edit-all-days" className="text-xs p-2 border rounded has-[:checked]:border-primary"> <RadioGroupItem value="all" id="edit-all-days" className="mr-1"/> Every Day </Label>
                                <Label htmlFor="edit-weekdays-only" className="text-xs p-2 border rounded has-[:checked]:border-primary"> <RadioGroupItem value="weekdays" id="edit-weekdays-only" className="mr-1"/> Weekdays Only </Label>
                            </RadioGroup>
                        )}
                        {frequency === 'weekly' && (
                            <ToggleGroup type="multiple" value={daysOfWeek} onValueChange={setDaysOfWeek} className="flex flex-wrap gap-1">
                                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => <ToggleGroupItem key={day} value={String(i)} className="rounded-full">{day}</ToggleGroupItem>)}
                            </ToggleGroup>
                        )}
                        {frequency === 'monthly' && (
                            <div>
                                <Label>Day of Month</Label>
                                <Select onValueChange={(v) => setDayOfMonth(Number(v))} value={String(dayOfMonth)}>
                                    <SelectTrigger><SelectValue/></SelectTrigger>
                                    <SelectContent>{Array.from({length: 28}, (_, i) => i + 1).map(d => <SelectItem key={d} value={String(d)}>{d}</SelectItem>)}</SelectContent>
                                </Select>
                            </div>
                        )}
                    </div>
                 </div>
                 <DialogFooter>
                    <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button onClick={handleSave}>Save Changes</Button>
                 </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}


function ManageRecurringTasksDialog({
  isOpen,
  onOpenChange,
  recurringChores,
  users,
  onUpdate,
  onDelete,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  recurringChores: ChoreTemplate[];
  users: HomeHubUser[];
  onUpdate: (choreId: string, assignedToEmail: string, recurrence: Recurrence) => void;
  onDelete: (choreId: string) => void;
}) {
    const [choreToEdit, setChoreToEdit] = useState<ChoreTemplate | null>(null);
    const [choreToDelete, setChoreToDelete] = useState<ChoreTemplate | null>(null);

    const usersByEmail = useMemo(() => new Map(users.map(u => [u.email, u])), [users]);
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    const getScheduleText = (recurrence: Recurrence) => {
        if (!recurrence) return 'One-time';
        switch (recurrence.frequency) {
            case 'daily':
                return `Daily ${recurrence.dailyOptions?.excludeWeekends ? '(Weekdays only)' : ''}`;
            case 'weekly':
                const days = recurrence.weeklyOptions?.daysOfWeek.sort().map(d => dayNames[d]).join(', ') || '';
                return `Weekly on ${days}`;
            case 'monthly':
                return `Monthly on day ${recurrence.monthlyOptions?.dayOfMonth}`;
            default:
                return 'Invalid schedule';
        }
    }

    return (
        <>
            <EditRecurringTaskDialog 
                isOpen={!!choreToEdit}
                onOpenChange={(open) => !open && setChoreToEdit(null)}
                chore={choreToEdit}
                users={users}
                onSave={onUpdate}
            />
            <AlertDialog open={!!choreToDelete} onOpenChange={(open) => !open && setChoreToDelete(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete this recurring task?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This will delete all future instances of &quot;{choreToDelete?.task}&quot; and stop it from being assigned. This cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => {
                            if (choreToDelete) onDelete(choreToDelete.id);
                            setChoreToDelete(null);
                        }} className={buttonVariants({ variant: "destructive" })}>
                            Delete Recurring Task
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            <Dialog open={isOpen} onOpenChange={onOpenChange}>
                <DialogContent className="max-w-3xl">
                    <DialogHeader>
                        <DialogTitle>Manage Recurring Tasks</DialogTitle>
                        <DialogDescription>
                            Edit or cancel your recurring chore schedules here.
                        </DialogDescription>
                    </DialogHeader>
                    <ScrollArea className="max-h-[60vh] mt-4">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Task</TableHead>
                                    <TableHead>Assigned To</TableHead>
                                    <TableHead>Schedule</TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {recurringChores.length > 0 ? (
                                    recurringChores.map(chore => (
                                        <TableRow key={chore.id}>
                                            <TableCell className="font-medium">{chore.task}</TableCell>
                                            <TableCell>{usersByEmail.get(chore.assignedToEmail || '')?.displayName || chore.assignedToEmail}</TableCell>
                                            <TableCell>{getScheduleText(chore.recurrence!)}</TableCell>
                                            <TableCell className="text-right">
                                                <Button variant="ghost" size="icon" onClick={() => setChoreToEdit(chore)}><Edit className="h-4 w-4"/></Button>
                                                <Button variant="ghost" size="icon" onClick={() => setChoreToDelete(chore)}><Trash2 className="h-4 w-4 text-destructive"/></Button>
                                            </TableCell>
                                        </TableRow>
                                    ))
                                ) : (
                                    <TableRow>
                                        <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No recurring tasks have been set up.</TableCell>
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </ScrollArea>
                    <DialogFooter>
                        <Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    )
}

function ChoreCalendar({ chores }: { chores: Chore[] }) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const choresByDate = useMemo(() => {
    const grouped = new Map<string, Chore[]>();
    chores.forEach(chore => {
      const day = format(parseISO(chore.dueDate), 'yyyy-MM-dd');
      if (!grouped.has(day)) {
        grouped.set(day, []);
      }
      grouped.get(day)!.push(chore);
    });
    return grouped;
  }, [chores]);

  const DayWithChores = ({ date }: { date: Date, displayMonth: Date }) => {
    const dayKey = format(date, 'yyyy-MM-dd');
    const choresForDay = choresByDate.get(dayKey);

    return (
      <Popover>
        <PopoverTrigger asChild disabled={!choresForDay}>
          <div className={cn("relative w-full h-full flex items-center justify-center", choresForDay && "cursor-pointer")}>
            {date.getDate()}
            {choresForDay && (
              <div className="absolute bottom-1 w-1.5 h-1.5 bg-primary rounded-full" />
            )}
          </div>
        </PopoverTrigger>
        {choresForDay && (
          <PopoverContent className="w-80">
            <div className="space-y-2">
              <h4 className="font-medium leading-none">{format(date, 'PPP')}</h4>
              <div className="space-y-2">
                {choresForDay.map(chore => (
                  <div key={chore.id} className="text-sm">
                    <p className="font-semibold">{chore.task}</p>
                    <p className="text-xs text-muted-foreground">
                      Assigned to: {chore.assignedToDisplayName}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </PopoverContent>
        )}
      </Popover>
    );
  };

  return (
    <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="default" className="h-9 px-3 md:h-11 md:px-8 text-xs md:text-sm"><CalendarIcon className="mr-2 h-4 w-4" /> Calendar</Button>
      </DialogTrigger>
      <DialogContent className="w-auto">
        <DialogHeader>
          <DialogTitle>Chore Calendar</DialogTitle>
          <DialogDescription>
            An overview of your household&apos;s scheduled chores.
          </DialogDescription>
        </DialogHeader>
        <Calendar
          mode="single"
          selected={new Date()}
          components={{
            Day: DayWithChores,
          }}
          className="rounded-md"
        />
        <DialogFooter>
            <Button variant="secondary" onClick={() => setIsDialogOpen(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ChoreChartClient() {
  const { currentUser } = useAuth();
  const { toast } = useToast();
  
  const [assignedChores, setAssignedChores] = useState<Chore[]>([]);
  const [choreTemplates, setChoreTemplates] = useState<ChoreTemplate[]>([]);
  const [householdUsers, setHouseholdUsers] = useState<HomeHubUser[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [isMounted, setIsMounted] = useState(false);
  const [openChoreAccordions, setOpenChoreAccordions] = useState<string[]>([]);
  
  const [isChoreTemplatesOpen, setIsChoreTemplatesOpen] = useState(false);
  const [isManageRoomsOpen, setIsManageRoomsOpen] = useState(false);
  const [isRecurringTasksOpen, setIsRecurringTasksOpen] = useState(false);
  const [isAssignDialogOpen, setIsAssignDialogOpen] = useState(false);
  const [templatesToAssign, setTemplatesToAssign] = useState<ChoreTemplate[]>([]);
  const [choreToConfirm, setChoreToConfirm] = useState<Chore | null>(null);
  
  const [showFullHistory, setShowFullHistory] = useState(false);
  const [showFullFuture, setShowFullFuture] = useState(false);
  const [filterRoomId, setFilterRoomId] = useState<string>('all');
  
  useEffect(() => {
    setIsMounted(true);
  }, []);

  const roomsById = useMemo(() => new Map(rooms.map(room => [room.id, room])), [rooms]);

  const getCollectionRef = useCallback((collectionName: string) => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, collectionName);
  }, [currentUser]);

  const fetchAllData = useCallback(async () => {
    if (!currentUser?.householdId || !currentUser.email) {
      setLoading(false);
      return;
    }
    setLoading(true);

    try {
        const householdDocRef = doc(db, 'households', currentUser.householdId);
        const householdDocSnap = await getDoc(householdDocRef);
        if (!householdDocSnap.exists()) {
            throw new Error("Household document not found.");
        }
        const memberEmails = householdDocSnap.data().memberEmails || [];
        const userPromises = memberEmails.map((email: string) => getDoc(doc(db, 'users', email)));
        const userDocsSnap = await Promise.all(userPromises);
        const usersData: HomeHubUser[] = userDocsSnap
            .filter(snap => snap.exists())
            .map(snap => ({ ...(snap.data() as HomeHubUser) }));
        setHouseholdUsers(usersData);

        const choresCollection = getCollectionRef('chores');
        const choreTemplatesCollection = getCollectionRef('chore-templates');
        const roomsCollection = getCollectionRef('rooms');

        if (!choresCollection || !choreTemplatesCollection || !roomsCollection) {
           setLoading(false);
           return;
        }
        
        const [choresSnapshot, templatesSnapshot, roomsSnapshot] = await Promise.all([
            getDocs(query(choresCollection)),
            getDocs(query(choreTemplatesCollection)),
            getDocs(query(roomsCollection)),
        ]);

        const ninetyDaysAgo = sub(new Date(), { days: 90 });
        const completedChoresQuery = query(choresCollection, where('isCompleted', '==', true));
        const completedChoresSnapshot = await getDocs(completedChoresQuery);
        
        const purgeBatch = writeBatch(db);
        let purgedCount = 0;
        completedChoresSnapshot.forEach(doc => {
            const chore = doc.data() as Chore;
            if (chore.completedAt && parseISO(chore.completedAt) < ninetyDaysAgo) {
                purgeBatch.delete(doc.ref);
                purgedCount++;
            }
        });
        
        if (purgedCount > 0) {
            await purgeBatch.commit();
        }

        const templatesData: ChoreTemplate[] = templatesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ChoreTemplate));
        setChoreTemplates(templatesData.sort((a,b) => a.task.localeCompare(b.task)));

        const roomsData: Room[] = roomsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Room));
        setRooms(roomsData.sort((a,b) => a.name.localeCompare(b.name)));

        const existingChoresData: Chore[] = choresSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Chore));
        
        const generationBatch = writeBatch(db);
        const generationLimit = 30;
        const recurringTemplates = templatesData.filter(t => t.recurrence && t.assignedToEmail);
        let generatedInThisPass = 0;
        
        for (const template of recurringTemplates) {
            const { recurrence, assignedToEmail, task } = template;
            if (!recurrence || !assignedToEmail) continue;

            const user = usersData.find(u => u.email === assignedToEmail);
            const assignedToDisplayName = user?.displayName || assignedToEmail;
            
            let nextDueDate = startOfToday();
            let generatedCount = 0;

            while (generatedCount < generationLimit) {
                let isValidDate = false;
                
                if (recurrence.frequency === 'daily') {
                    if (recurrence.dailyOptions?.excludeWeekends) {
                        const day = getDay(nextDueDate);
                        if (day > 0 && day < 6) isValidDate = true;
                    } else {
                        isValidDate = true;
                    }
                } else if (recurrence.frequency === 'weekly' && recurrence.weeklyOptions) {
                    const day = getDay(nextDueDate);
                    if (recurrence.weeklyOptions.daysOfWeek.includes(day)) {
                        isValidDate = true;
                    }
                } else if (recurrence.frequency === 'monthly' && recurrence.monthlyOptions) {
                    if (nextDueDate.getDate() === recurrence.monthlyOptions.dayOfMonth) {
                        isValidDate = true;
                    }
                }

                if (isValidDate) {
                    const originalDueDate = format(nextDueDate, 'yyyy-MM-dd');
                    const roomsToAssign = template.roomIds && template.roomIds.length > 0 ? template.roomIds : ['general'];
                    
                    roomsToAssign.forEach(roomId => {
                        const choreId = stableSlugify(`${template.id}-${roomId}-${originalDueDate}-${assignedToEmail}`);
                        const exists = existingChoresData.some(c => c.id === choreId);
                        
                        if (!exists) {
                            const newChore: Omit<Chore, 'id'> = {
                                task,
                                assignedToEmail,
                                assignedToDisplayName,
                                dueDate: nextDueDate.toISOString(),
                                isCompleted: false,
                                notes: template.notes || '',
                                subTasks: template.subTasks || [],
                                completedSubTasks: [],
                                templateId: template.id,
                                originalDueDate: originalDueDate,
                                roomIds: roomId === 'general' ? [] : [roomId],
                            };
                            generationBatch.set(doc(choresCollection, choreId), newChore);
                            generatedInThisPass++;
                        }
                    });
                    generatedCount++;
                }
                nextDueDate = addDays(nextDueDate, 1);
            }
        }

        if (generatedInThisPass > 0) {
            await generationBatch.commit();
            const finalChoresSnapshot = await getDocs(query(choresCollection));
            const finalChoresData: Chore[] = finalChoresSnapshot.docs.map(doc => {
                const chore = { id: doc.id, ...doc.data() } as Chore;
                const user = usersData.find(u => u.email === chore.assignedToEmail);
                return {
                    ...chore,
                    assignedToDisplayName: user?.displayName || chore.assignedToEmail,
                };
            });
            setAssignedChores(finalChoresData);
        } else {
            setAssignedChores(existingChoresData.map(chore => {
                const user = usersData.find(u => u.email === chore.assignedToEmail);
                return {
                    ...chore,
                    assignedToDisplayName: user?.displayName || chore.assignedToEmail,
                };
            }));
        }

    } catch (error) {
        console.error("Error fetching data:", error instanceof Error ? error : String(error));
        toast({ variant: 'destructive', title: 'Error', description: 'Could not fetch household data.' });
    } finally {
        setLoading(false);
    }
  }, [getCollectionRef, currentUser, toast]);

  useEffect(() => {
    if (currentUser?.householdId) {
      fetchAllData();
    } else {
      setLoading(false);
    }
  }, [currentUser, fetchAllData]);
  
    useEffect(() => {
        if (!householdUsers.length || !assignedChores.length || !currentUser?.email) {
            return;
        }

        const intervalId = setInterval(async () => {
            const now = new Date();
            const dateStr = format(now, 'yyyy-MM-dd');
            const user = householdUsers.find(u => u.email === currentUser.email);
            if (!user) return;

            const settings = user.choreSettings;
            
            // 1. Overdue Alerts (After Midnight check)
            // Chores are overdue if due date is in the past and NOT today
            const overdueChores = assignedChores.filter(c => 
                c.assignedToEmail === user.email &&
                !c.isCompleted && 
                isPast(parseISO(c.dueDate)) && !isToday(parseISO(c.dueDate))
            );

            // We check if it's past 12:01 AM
            if (overdueChores.length > 0) {
                const overdueNotifId = `overdue-${dateStr}`;
                const notifRef = doc(db, 'users', user.email, 'notifications', overdueNotifId);
                
                // Use a simple check to see if we've already notified for this deterministic ID today
                const snap = await getDoc(notifRef);
                if (!snap.exists()) {
                    const message = `Alert: You have ${overdueChores.length} overdue chore${overdueChores.length > 1 ? 's' : ''}!`;
                    setDoc(notifRef, { 
                        message, 
                        href: '/chores', 
                        createdAt: new Date(), 
                        isRead: false 
                    });
                }
            }

            // 2. User's Daily Custom Reminder
            if (settings?.reminderEnabled && settings?.reminderTime) {
                const [hours, minutes] = settings.reminderTime.split(':').map(Number);
                // Trigger if current time is after or equal to the reminder time
                if (now.getHours() > hours || (now.getHours() === hours && now.getMinutes() >= minutes)) {
                    const todayChores = assignedChores.filter(c => 
                        c.assignedToEmail === user.email &&
                        !c.isCompleted && 
                        isToday(parseISO(c.dueDate))
                    );
                    
                    const totalPending = overdueChores.length + todayChores.length;
                    if (totalPending > 0) {
                        const customNotifId = `reminder-${dateStr}`;
                        const customNotifRef = doc(db, 'users', user.email, 'notifications', customNotifId);
                        const snap = await getDoc(customNotifRef);
                        if (!snap.exists()) {
                            const message = `Daily Reminder: You have ${totalPending} chore${totalPending > 1 ? 's' : ''} pending.`;
                            setDoc(customNotifRef, { 
                                message, 
                                href: '/chores', 
                                createdAt: new Date(), 
                                isRead: false 
                            });
                        }
                    }
                }
            }
        }, 60 * 1000);

        return () => clearInterval(intervalId);
    }, [householdUsers, assignedChores, currentUser]);

  const handleSaveChoreTemplate = async (choreData: Partial<ChoreTemplate>, id?: string) => {
    const templatesCollection = getCollectionRef('chore-templates');
    const choresCollection = getCollectionRef('chores');
    if (!templatesCollection || !choresCollection) return;

    const templateId = id || stableSlugify(choreData.task!);
    const templateRef = doc(templatesCollection, templateId);
    
    try {
        await runTransaction(db, async (transaction) => {
            const oldTemplateSnap = id ? await transaction.get(templateRef) : null;
            const oldTemplate = oldTemplateSnap?.exists() ? oldTemplateSnap.data() as ChoreTemplate : null;

            transaction.set(templateRef, choreData, { merge: true });
            
            if (id) {
                 const q = query(choresCollection, where('templateId', '==', id), where('isCompleted', '==', false));
                 const choresToUpdateSnap = await getDocs(q);
                 choresToUpdateSnap.forEach(choreDoc => {
                    transaction.update(choreDoc.ref, { 
                        task: choreData.task,
                        notes: choreData.notes,
                        subTasks: choreData.subTasks,
                    });
                 });
            }

            if (oldTemplate && oldTemplate.roomIds && choreData.roomIds) {
                const removedRoomIds = oldTemplate.roomIds.filter(roomId => !choreData.roomIds!.includes(roomId));
                if (removedRoomIds.length > 0) {
                    const q = query(choresCollection, where('templateId', '==', templateId), where('isCompleted', '==', false));
                    const choresSnap = await getDocs(q);
                    choresSnap.forEach(choreDoc => {
                        const chore = choreDoc.data() as Chore;
                        if (chore.roomIds && chore.roomIds.some(rId => removedRoomIds.includes(rId))) {
                            transaction.delete(choreDoc.ref);
                        }
                    });
                }
            }
        });

        toast({ title: id ? 'Chore Updated' : 'Chore Created' });
        await fetchAllData();
    } catch(error) {
        console.error("Error saving chore template:", error)
        toast({ variant: 'destructive', title: 'Error', description: 'Could not save chore.' });
    }
  }

  const handleDeleteChoreTemplate = async (id: string) => {
    const templatesCollection = getCollectionRef('chore-templates');
    const choresCollection = getCollectionRef('chores');
    if (!templatesCollection || !choresCollection) return;
    
    try {
        await runTransaction(db, async (transaction) => {
            transaction.delete(doc(templatesCollection, id));
            const q = query(choresCollection, where('templateId', '==', id), where('isCompleted', '==', false));
            const existingChoresSnap = await getDocs(q);
            existingChoresSnap.forEach(choreDoc => {
                transaction.delete(choreDoc.ref);
            });
        });

        toast({ title: 'Chore Deleted' });
        await fetchAllData();
    } catch(error) {
        console.error("Error deleting template:", error);
        toast({ variant: 'destructive', title: 'Error', description: 'Could not delete chore.' });
    }
  }
  
  const handleOpenAssignDialog = (templates: ChoreTemplate[]) => {
      setTemplatesToAssign(templates);
      setIsAssignDialogOpen(true);
      setIsChoreTemplatesOpen(false);
  }

  const handleAssignChores = useCallback(async (
      assignment: { assignedToEmail: string, roomIds: string[] },
      schedule: { type: 'onetime'; dueDate: Date } | { type: 'recurring'; recurrence: Omit<Recurrence, 'assignedToEmail'> }
    ) => {
    if (!currentUser?.householdId || templatesToAssign.length === 0) return;
    
    const templatesCollection = getCollectionRef('chore-templates');
    const choresCollection = getCollectionRef('chores');
    if (!choresCollection || !templatesCollection) return;

    const batch = writeBatch(db);
    const user = householdUsers.find(u => u.email === assignment.assignedToEmail);
    const assignedToDisplayName = user?.displayName || assignment.assignedToEmail;

    const notificationsCollectionRef = collection(db, 'users', assignment.assignedToEmail, 'notifications');
    const notificationMessage = templatesToAssign.length > 1
        ? `You have been assigned ${templatesToAssign.length} new chores.`
        : `You have a new chore: ${templatesToAssign[0].task}.`;

    const newNotification = {
        message: notificationMessage,
        href: '/chores',
        createdAt: new Date(),
        isRead: false,
    };
    batch.set(doc(notificationsCollectionRef), newNotification);


    if (schedule.type === 'recurring') {
        for (const template of templatesToAssign) {
            const templateRef = doc(templatesCollection, template.id);
            const recurrenceData: Recurrence = { ...schedule.recurrence, assignedToEmail: assignment.assignedToEmail };
            batch.update(templateRef, { recurrence: recurrenceData, assignedToEmail: assignment.assignedToEmail });
        }
        toast({ title: 'Recurring Chores Set!', description: `These chores will now be assigned automatically.` });
    } else {
        for (const template of templatesToAssign) {
            const originalDueDate = format(schedule.dueDate, 'yyyy-MM-dd');
            const roomsToAssign = assignment.roomIds.length > 0 ? assignment.roomIds : (template.roomIds && template.roomIds.length > 0 ? template.roomIds : ['general']);

            roomsToAssign.forEach(roomId => {
                const choreId = stableSlugify(`${template.id}-${roomId}-${originalDueDate}-${assignment.assignedToEmail}`);
                const newChore: Omit<Chore, 'id'> = {
                    task: template.task,
                    assignedToEmail: assignment.assignedToEmail,
                    assignedToDisplayName: assignedToDisplayName,
                    dueDate: schedule.dueDate.toISOString(),
                    isCompleted: false,
                    notes: template.notes || '',
                    subTasks: template.subTasks || [],
                    completedSubTasks: [],
                    templateId: template.id,
                    originalDueDate: originalDueDate,
                    roomIds: roomId === 'general' ? [] : [roomId],
                };
                batch.set(doc(choresCollection, choreId), newChore);
            })
        }
        toast({ title: 'Chores Assigned!', description: `${templatesToAssign.length} chore(s) have been added to the chart.` });
    }
    
    try {
        await batch.commit();
        await fetchAllData();
    } catch(error) {
        console.error("Error assigning chores:", error);
        toast({ variant: 'destructive', title: 'Error', description: 'Could not assign chores.' });
    }

  }, [currentUser, getCollectionRef, householdUsers, templatesToAssign, toast, fetchAllData]);


  const handleSaveRoom = async (roomData: { name: string, icon: string }, id?: string) => {
    const roomsCollection = getCollectionRef('rooms');
    if (!roomsCollection) return;
    const roomId = id || stableSlugify(roomData.name);
    try {
        await setDoc(doc(roomsCollection, roomId), roomData);
        toast({ title: id ? 'Room Updated' : 'Room Added' });
        await fetchAllData();
    } catch {
        toast({ variant: 'destructive', title: 'Error', description: 'Could not save room.' });
    }
  }

  const handleDeleteRoom = async (id: string) => {
    const roomsCollection = getCollectionRef('rooms');
    const templatesCollection = getCollectionRef('chore-templates');
    if (!roomsCollection || !templatesCollection) return;
    try {
        await runTransaction(db, async (transaction) => {
            transaction.delete(doc(roomsCollection, id));
            const templatesToUpdate = choreTemplates.filter(t => t.roomIds?.includes(id));
            for (const template of templatesToUpdate) {
                const templateRef = doc(templatesCollection, template.id);
                const newRoomIds = template.roomIds?.filter(roomId => roomId !== id);
                transaction.update(templateRef, { roomIds: newRoomIds });
            }
        });
        toast({ title: 'Room Deleted', description: "The room was deleted and unassigned from chores."});
        await fetchAllData();
    } catch {
        toast({ variant: 'destructive', title: 'Error', description: 'Could not delete room.' });
    }
  }
  
  const handleUpdateRecurringTask = async (choreId: string, assignedToEmail: string, recurrence: Recurrence) => {
    const templatesCollection = getCollectionRef('chore-templates');
    const choresCollection = getCollectionRef('chores');
    if (!templatesCollection || !choresCollection) return;

    try {
        await runTransaction(db, async (transaction) => {
            const templateRef = doc(templatesCollection, choreId);
            transaction.update(templateRef, { assignedToEmail, recurrence });
            const q = query(choresCollection, where('templateId', '==', choreId), where('isCompleted', '==', false));
            const existingChoresSnap = await getDocs(q);
            existingChoresSnap.forEach(choreDoc => {
                transaction.delete(choreDoc.ref);
            });
        });
        toast({ title: 'Recurring Task Updated' });
        await fetchAllData();
    } catch(error) {
        console.error("Error updating recurring task:", error);
        toast({ variant: 'destructive', title: 'Error', description: 'Could not update recurring task.' });
    }
  };

  const handleDeleteRecurringTask = async (choreId: string) => {
    const templatesCollection = getCollectionRef('chore-templates');
    const choresCollection = getCollectionRef('chores');
    if (!templatesCollection || !choresCollection) return;

    try {
        await runTransaction(db, async (transaction) => {
            const templateRef = doc(templatesCollection, choreId);
            transaction.update(templateRef, { recurrence: null, assignedToEmail: null });
            const q = query(choresCollection, where('templateId', '==', choreId), where('isCompleted', '==', false));
            const existingChoresSnap = await getDocs(q);
            existingChoresSnap.forEach(choreDoc => {
                transaction.delete(choreDoc.ref);
            });
        });

        toast({ title: 'Recurring Task Canceled' });
        await fetchAllData();
    } catch(error) {
        console.error("Error deleting recurring task:", error);
        toast({ variant: 'destructive', title: 'Error', description: 'Could not cancel recurring task.' });
    }
  };


  const completeChore = async (chore: Chore, completeAllSubtasks = false) => {
    const choresCollection = getCollectionRef('chores');
    if (!choresCollection) return;

    const choreRef = doc(choresCollection, chore.id);
    const updates: Partial<Chore> = { isCompleted: true, completedAt: new Date().toISOString() };
    if (completeAllSubtasks) {
        updates.completedSubTasks = chore.subTasks || [];
    }

    try {
        await updateDoc(choreRef, updates);
        setAssignedChores(prevChores => 
            prevChores.map(c => 
                c.id === chore.id 
                ? { ...c, ...updates }
                : c
            )
        );
    } catch {
        toast({ variant: 'destructive', title: 'Error', description: 'Could not update chore.' });
    }
  }

  const handleToggleChore = (chore: Chore) => {
    if (chore.isCompleted) {
        const choreRef = doc(getCollectionRef('chores')!, chore.id);
        const updates = { isCompleted: false, completedSubTasks: [], completedAt: null };
        updateDoc(choreRef, updates).then(() => {
             setAssignedChores(prevChores => 
                prevChores.map(c => 
                    c.id === chore.id 
                    ? { ...c, ...updates }
                    : c
                )
            );
        });
    } else {
        const allSubTasksCompleted = (chore.subTasks?.length || 0) === (chore.completedSubTasks?.length || 0);
        if (allSubTasksCompleted) {
            completeChore(chore);
        } else {
            setChoreToConfirm(chore);
        }
    }
  }

  const handleSubTaskToggle = async (chore: Chore, subTask: string) => {
    const choresCollection = getCollectionRef('chores');
    if (!choresCollection) return;

    const choreRef = doc(choresCollection, chore.id);
    const currentCompleted = chore.completedSubTasks || [];
    const isCompleted = currentCompleted.includes(subTask);
    const newCompletedSubTasks = isCompleted
      ? currentCompleted.filter((st) => st !== subTask)
      : [...currentCompleted, subTask];
    
    setAssignedChores(prevChores => 
        prevChores.map(c => 
            c.id === chore.id 
            ? { ...c, completedSubTasks: newCompletedSubTasks }
            : c
        )
    );

    try {
        await updateDoc(choreRef, { completedSubTasks: newCompletedSubTasks });
    } catch {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Could not update sub-task.',
      });
       setAssignedChores(prevChores => 
            prevChores.map(c => 
                c.id === chore.id 
                ? { ...c, completedSubTasks: currentCompleted }
                : c
            )
        );
    }
  };
  
  const deleteAssignedChore = async (id: string) => {
    const choresCollection = getCollectionRef('chores');
    if (!choresCollection) return;
    const choreRef = doc(choresCollection, id);
    try {
        await deleteDoc(choreRef);
        toast({ title: 'Chore Removed' });
        await fetchAllData();
    } catch {
        toast({ variant: 'destructive', title: 'Error', description: 'Could not delete chore.' });
    }
  };

  const handleReassignChore = async (choreId: string, newEmail: string) => {
    const choreRef = doc(getCollectionRef('chores')!, choreId);
    const user = householdUsers.find(u => u.email === newEmail);
    if (!user) return;

    const updates = {
      assignedToEmail: newEmail,
      assignedToDisplayName: user.displayName || newEmail,
    };
    
    setAssignedChores(prev => prev.map(c => c.id === choreId ? {...c, ...updates} : c));

    try {
      await updateDoc(choreRef, updates);
      toast({ title: 'Chore Reassigned' });
    } catch {
      toast({ variant: 'destructive', title: 'Reassignment Failed' });
      fetchAllData();
    }
  };

  if (loading || !isMounted) {
    return (
        <div className="space-y-8">
            <Card>
                <CardHeader>
                    <Skeleton className="h-8 w-1/2" />
                    <Skeleton className="h-4 w-3/4" />
                </CardHeader>
                <CardContent className="space-y-4">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                </CardContent>
            </Card>
        </div>
    )
  }
  
  if (!currentUser) {
    return <p className="text-center py-8 text-sm">Please log in to manage chores.</p>;
  }
  
  const today = endOfToday();

  const filteredChores = assignedChores.filter(chore => {
    if (filterRoomId === 'all') return true;
    if (filterRoomId === 'general') return !chore.roomIds || chore.roomIds.length === 0;
    return chore.roomIds?.includes(filterRoomId);
  });

  const upcomingChores = filteredChores
    .filter(c => !c.isCompleted && !isAfter(parseISO(c.dueDate), today))
    .sort((a,b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
    
  const futureChores = filteredChores
    .filter(c => !c.isCompleted && isAfter(parseISO(c.dueDate), today))
    .sort((a,b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

  const seventyTwoHoursAgo = sub(today, { hours: 72 });
  const sevenDaysFromNow = add(today, { days: 7 });

  const completedChores = filteredChores
    .filter(c => c.isCompleted && c.completedAt)
    .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime());

  const visibleCompletedChores = showFullHistory 
    ? completedChores 
    : completedChores.filter(c => isAfter(parseISO(c.completedAt!), seventyTwoHoursAgo));
    
  const visibleFutureChores = showFullFuture
    ? futureChores
    : futureChores.filter(c => !isAfter(parseISO(c.dueDate), sevenDaysFromNow));
    
  const recurringChores = choreTemplates.filter(t => !!t.recurrence);


  const groupChoresByRoom = (chores: Chore[]) => {
    const grouped = chores.reduce((acc, chore) => {
        if (chore.roomIds && chore.roomIds.length > 0) {
            chore.roomIds.forEach(roomId => {
                const room = roomsById.get(roomId) || { name: 'Unknown Room', icon: 'HelpCircle' };
                if (!acc[room.name]) acc[room.name] = { icon: room.icon, chores: [] };
                acc[room.name].chores.push(chore);
            });
        } else {
            if (!acc['General']) acc['General'] = { icon: 'Home', chores: [] };
            acc['General'].chores.push(chore);
        }
        return acc;
    }, {} as Record<string, { icon: string, chores: Chore[] }>);

    return Object.entries(grouped).sort(([a], [b]) => {
        if (a === 'General') return 1;
        if (b === 'General') return -1;
        return a.localeCompare(b);
    });
  };

  const ChoreList = ({ chores }: { chores: Chore[] }) => (
    <div className="space-y-2 pl-2 md:pl-4">
        <Accordion 
            type="multiple" 
            className="w-full"
            value={openChoreAccordions}
            onValueChange={setOpenChoreAccordions}
        >
            {chores.map((chore) => {
                const isOverdue = isPast(parseISO(chore.dueDate)) && !isToday(parseISO(chore.dueDate));
                const isCompleted = chore.isCompleted;
                const hasDetails = chore.notes || (chore.subTasks && chore.subTasks.length > 0);

                return (
                <div key={chore.id} className={cn("border rounded-lg bg-secondary/30", isOverdue && !isCompleted && "border-destructive/50 bg-destructive/10")}>
                    <AccordionItem value={chore.id} className="border-b-0">
                        <div className="flex items-center gap-2 px-2 py-1 md:px-4 md:py-3">
                             <Checkbox 
                                id={`chore-${chore.id}`} 
                                checked={isCompleted} 
                                onCheckedChange={() => handleToggleChore(chore)} 
                                className="h-4 w-4 md:h-5 md:w-5 shrink-0 ml-1"
                             />
                             
                             <AccordionPrimitive.Header className="flex flex-1 min-w-0">
                                <AccordionPrimitive.Trigger asChild>
                                    <button 
                                        className="flex flex-1 flex-col text-left items-start min-w-0 bg-transparent border-0 outline-none cursor-pointer py-2 md:py-0"
                                        aria-label={`Show details for ${chore.task}`}
                                    >
                                        <span className={cn("font-medium text-xs md:text-base block truncate w-full", isOverdue && !isCompleted && "text-destructive", isCompleted && "text-muted-foreground line-through")}>
                                            {chore.task}
                                        </span>
                                        <div className={cn("text-[9px] md:text-xs text-muted-foreground", isCompleted && "line-through")}>
                                            {format(parseISO(chore.dueDate), 'MMM d')}
                                        </div>
                                    </button>
                                </AccordionPrimitive.Trigger>
                             </AccordionPrimitive.Header>

                             <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button className={cn("flex items-center justify-start text-[9px] md:text-xs h-auto p-1 text-muted-foreground hover:bg-accent rounded-md min-w-[80px] shrink-0", isCompleted && "line-through")}>
                                        <UserIcon className="mr-1 h-2.5 w-2.5 md:h-3 md:w-3" /> {chore.assignedToDisplayName} <ChevronDown className="ml-0.5 h-2.5 w-2.5 md:h-3 md:w-3" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-[180px]">
                                    <DropdownMenuRadioGroup value={chore.assignedToEmail} onValueChange={(email) => handleReassignChore(chore.id, email)}>
                                    {householdUsers.map(user => (
                                        <DropdownMenuRadioItem key={user.email} value={user.email}>
                                            {user.displayName}
                                        </DropdownMenuRadioItem>
                                    ))}
                                    </DropdownMenuRadioGroup>
                                </DropdownMenuContent>
                             </DropdownMenu>

                             <div className="flex items-center gap-1 shrink-0">
                                {hasDetails && (
                                    <AccordionPrimitive.Trigger asChild>
                                        <button className="flex items-center justify-center h-7 w-7 md:h-8 md:w-8 rounded-md hover:bg-accent [&[data-state=open]>svg]:-rotate-180 transition-transform">
                                            <ChevronDown className="h-3.5 w-3.5 md:h-4 md:w-4" />
                                            <span className="sr-only">Toggle Details</span>
                                        </button>
                                    </AccordionPrimitive.Trigger>
                                )}
                                <button className="flex items-center justify-center h-7 w-7 md:h-8 md:w-8 rounded-md hover:bg-accent" onClick={() => deleteAssignedChore(chore.id)}>
                                    <Trash2 className="h-3.5 w-3.5 md:h-4 md:w-4 text-muted-foreground" />
                                    <span className="sr-only">Delete Chore</span>
                                </button>
                             </div>
                        </div>
                        <AccordionContent className="px-4 pb-4">
                            {chore.notes && <p className="text-[10px] md:text-xs text-muted-foreground mb-3 pt-2 border-t whitespace-pre-wrap">{chore.notes}</p>}
                            {(chore.subTasks && chore.subTasks.length > 0) && (
                            <div className="space-y-1.5 pt-2 border-t">
                                <h4 className="font-semibold text-[10px] md:text-xs">Sub-Tasks</h4>
                                {chore.subTasks.map(subTask => (
                                <div key={subTask} className="flex items-center gap-2">
                                    <Checkbox
                                    id={`subtask-${chore.id}-${stableSlugify(subTask)}`}
                                    checked={(chore.completedSubTasks || []).includes(subTask)}
                                    onCheckedChange={() => handleSubTaskToggle(chore, subTask)}
                                    disabled={isCompleted}
                                    className="h-3 w-3 md:h-3.5 md:w-3.5"
                                    />
                                    <Label htmlFor={`subtask-${chore.id}-${stableSlugify(subTask)}`} className={cn("text-[10px] md:text-xs font-normal", isCompleted && "text-muted-foreground line-through")}>
                                    {subTask}
                                    </Label>
                                </div>
                                ))}
                            </div>
                            )}
                        </AccordionContent>
                    </AccordionItem>
                </div>
                );
            })}
        </Accordion>
    </div>
  );

  return (
    <>
        <AlertDialog open={!!choreToConfirm} onOpenChange={(open) => !open && setChoreToConfirm(null)}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Complete All Sub-Tasks?</AlertDialogTitle>
                    <AlertDialogDescription>
                        There are still open sub-tasks. Tapping confirm will mark all sub-tasks as done and complete this chore.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Go Back</AlertDialogCancel>
                    <AlertDialogAction onClick={() => {
                        if (choreToConfirm) {
                            completeChore(choreToConfirm, true);
                            setChoreToConfirm(null);
                        }
                    }}>
                        Confirm & Complete All
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>


        <ManageChoresDialog
            isOpen={isChoreTemplatesOpen}
            onOpenChange={setIsChoreTemplatesOpen}
            choreTemplates={choreTemplates}
            rooms={rooms}
            onChoreTemplateSave={handleSaveChoreTemplate}
            onChoreTemplateDelete={handleDeleteChoreTemplate}
            onAssignChores={handleOpenAssignDialog}
        />
        
        <AssignChoresDialog 
            isOpen={isAssignDialogOpen}
            onOpenChange={setIsAssignDialogOpen}
            users={householdUsers}
            rooms={rooms}
            templatesToAssign={templatesToAssign}
            onAssign={handleAssignChores}
        />

        <ManageRoomsDialog 
            isOpen={isManageRoomsOpen}
            onOpenChange={setIsManageRoomsOpen}
            rooms={rooms}
            onRoomSave={handleSaveRoom}
            onRoomDelete={handleDeleteRoom}
        />

        <ManageRecurringTasksDialog
             isOpen={isRecurringTasksOpen}
             onOpenChange={setIsRecurringTasksOpen}
             recurringChores={recurringChores}
             users={householdUsers}
             onUpdate={handleUpdateRecurringTask}
             onDelete={handleDeleteRecurringTask}
        />
        
        <div className="flex flex-col justify-center items-center mb-6 md:mb-8 text-center">
            <div className="mb-4">
                <h1 className="font-headline text-xl md:text-3xl font-bold tracking-tight">Chore Chart</h1>
                <p className="text-muted-foreground text-[10px] md:text-sm">Manage household tasks and responsibilities.</p>
            </div>
             <div className="flex flex-wrap justify-center gap-2">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="default" className="h-8 px-2 md:h-11 md:px-8 text-[10px] md:text-sm">
                            <Filter className="mr-1 h-3 w-3 md:mr-2 md:h-4 md:w-4" /> 
                            {filterRoomId === 'all' ? 'All Rooms' : (filterRoomId === 'general' ? 'General' : rooms.find(r => r.id === filterRoomId)?.name || 'Filter')}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuLabel>Filter by Room</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuRadioGroup value={filterRoomId} onValueChange={setFilterRoomId}>
                            <DropdownMenuRadioItem value="all">All Rooms</DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="general">General</DropdownMenuRadioItem>
                            {rooms.length > 0 ? rooms.map(room => (
                                <DropdownMenuRadioItem key={room.id} value={room.id}>
                                    <div className="flex items-center gap-2">
                                        {renderIcon(room.icon, { className: 'h-3 w-3' })}
                                        {room.name}
                                    </div>
                                </DropdownMenuRadioItem>
                            )) : (
                                <DropdownMenuItem disabled className="text-center italic">No rooms created yet</DropdownMenuItem>
                            )}
                        </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                </DropdownMenu>
                <ChoreCalendar chores={assignedChores} />
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button size="default" className="h-8 px-2 md:h-11 md:px-8 text-[10px] md:text-sm"><MoreVertical className="mr-1 h-3 w-3 md:mr-2 md:h-4 md:w-4" /> Chore Manager</Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                         <DropdownMenuItem onSelect={() => setIsChoreTemplatesOpen(true)}>
                            <BookUser className="mr-2 h-4 w-4"/> Chores
                         </DropdownMenuItem>
                         <DropdownMenuItem onSelect={() => setIsManageRoomsOpen(true)}>
                            <Home className="mr-2 h-4 w-4"/> Manage Rooms
                         </DropdownMenuItem>
                         <DropdownMenuItem onSelect={() => setIsRecurringTasksOpen(true)}>
                           <Repeat className="mr-2 h-4 w-4"/> Manage Recurring Tasks
                         </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </div>

        <div className="space-y-3 md:space-y-4">
             <Accordion type="multiple" defaultValue={['todo']} className="w-full space-y-3 md:space-y-4">
                 <AccordionItem value="todo" className="border rounded-lg px-3 md:px-4 bg-background">
                     <AccordionTrigger className="hover:no-underline font-headline text-sm md:text-xl py-2 md:py-3">To Do ({upcomingChores.length})</AccordionTrigger>
                     <AccordionContent className="pt-1">
                        {upcomingChores.length > 0 ? (
                           <Accordion type="multiple" className="w-full space-y-2" defaultValue={groupChoresByRoom(upcomingChores).map(([roomName]) => `todo-${roomName}`)}>
                            {groupChoresByRoom(upcomingChores).map(([roomName, {icon, chores}]) => (
                                <AccordionItem value={`todo-${roomName}`} key={`todo-${roomName}`} className="border rounded-lg px-2 md:px-4 bg-background">
                                    <AccordionTrigger className="hover:no-underline text-[11px] md:text-base font-semibold py-1.5 md:py-2">
                                       <div className="flex items-center gap-2">
                                          {renderIcon(icon, { className: 'h-3.5 w-3.5 md:h-4 md:w-4' })} {roomName} ({chores.length})
                                       </div>
                                    </AccordionTrigger>
                                    <AccordionContent>
                                        <ChoreList chores={chores} />
                                    </AccordionContent>
                                </AccordionItem>
                            ))}
                           </Accordion>
                        ) : (
                           <p className="text-center text-muted-foreground py-6 text-[10px] md:text-sm">All caught up!</p>
                        )}
                    </AccordionContent>
                 </AccordionItem>

                 <AccordionItem value="future" className="border rounded-lg px-3 md:px-4 bg-background">
                     <div className="flex items-center justify-between border-b-0">
                        <AccordionPrimitive.Header className="flex flex-1">
                            <AccordionPrimitive.Trigger asChild>
                                <button className="flex flex-1 items-center justify-between py-2 md:py-3 font-headline text-sm md:text-xl text-left hover:no-underline hover:opacity-80 transition-opacity">
                                    Future ({visibleFutureChores.length})
                                    <ChevronDown className="h-4 w-4 md:h-5 md:w-5 shrink-0 transition-transform duration-200" />
                                </button>
                            </AccordionPrimitive.Trigger>
                        </AccordionPrimitive.Header>
                        <div className="flex items-center space-x-2 ml-4 mr-2 md:mr-4 shrink-0">
                            <Switch id="show-full-future" checked={showFullFuture} onCheckedChange={setShowFullFuture} className="h-4 w-7 md:h-5 md:w-9"/>
                            <Label htmlFor="show-full-future" className="text-[9px] md:text-sm cursor-pointer">Show All</Label>
                        </div>
                     </div>
                     <AccordionContent className="pt-1">
                        {visibleFutureChores.length > 0 ? (
                            <Accordion type="multiple" className="w-full space-y-2" defaultValue={groupChoresByRoom(visibleFutureChores).map(([roomName]) => `future-${roomName}`)}>
                                {groupChoresByRoom(visibleFutureChores).map(([roomName, {icon, chores}]) => (
                                <AccordionItem value={`future-${roomName}`} key={`future-${roomName}`} className="border rounded-lg px-2 md:px-4 bg-background">
                                     <AccordionTrigger className="hover:no-underline text-[11px] md:text-base font-semibold py-1.5 md:py-2">
                                       <div className="flex items-center gap-2">
                                          {renderIcon(icon, { className: 'h-3.5 w-3.5 md:h-4 md:w-4' })} {roomName} ({chores.length})
                                       </div>
                                    </AccordionTrigger>
                                    <AccordionContent>
                                        <ChoreList chores={chores} />
                                    </AccordionContent>
                                </AccordionItem>
                            ))}
                           </Accordion>
                        ) : (
                            <p className="text-center text-muted-foreground py-6 text-[10px] md:text-sm">No chores scheduled soon.</p>
                        )}
                    </AccordionContent>
                 </AccordionItem>

                 <AccordionItem value="completed" className="border rounded-lg px-3 md:px-4 bg-background">
                     <div className="flex items-center justify-between border-b-0">
                        <AccordionPrimitive.Header className="flex flex-1">
                            <AccordionPrimitive.Trigger asChild>
                                <button className="flex flex-1 items-center justify-between py-2 md:py-3 font-headline text-sm md:text-xl text-left hover:no-underline hover:opacity-80 transition-opacity">
                                    Completed ({visibleCompletedChores.length})
                                    <ChevronDown className="h-4 w-4 md:h-5 md:w-5 shrink-0 transition-transform duration-200" />
                                </button>
                            </AccordionPrimitive.Trigger>
                        </AccordionPrimitive.Header>
                        <div className="flex items-center space-x-2 ml-4 mr-2 md:mr-4 shrink-0">
                            <Switch id="show-full-history" checked={showFullHistory} onCheckedChange={setShowFullHistory} className="h-4 w-7 md:h-5 md:w-9"/>
                            <Label htmlFor="show-full-history" className="text-[9px] md:text-sm cursor-pointer">History</Label>
                        </div>
                     </div>
                     <AccordionContent className="pt-1">
                        {visibleCompletedChores.length > 0 ? (
                            <Accordion type="multiple" className="w-full space-y-2">
                                {groupChoresByRoom(visibleCompletedChores).map(([roomName, {icon, chores}]) => (
                                <AccordionItem value={`completed-${roomName}`} key={`completed-${roomName}`} className="border rounded-lg px-2 md:px-4 bg-background">
                                    <AccordionTrigger className="hover:no-underline text-[11px] md:text-base font-semibold py-1.5 md:py-2">
                                       <div className="flex items-center gap-2">
                                          {renderIcon(icon, { className: 'h-3.5 w-3.5 md:h-4 md:w-4' })} {roomName} ({chores.length})
                                       </div>
                                    </AccordionTrigger>
                                    <AccordionContent>
                                        <ChoreList chores={chores} />
                                    </AccordionContent>
                                </AccordionItem>
                            ))}
                           </Accordion>
                        ) : (
                            <p className="text-center text-muted-foreground py-6 text-[10px] md:text-sm">No chores completed recently.</p>
                        )}
                    </AccordionContent>
                 </AccordionItem>
             </Accordion>
        </div>
    </>
  );
}
