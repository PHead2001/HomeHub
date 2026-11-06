'use client';

import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Check, PlusCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import type { ShoppingList, ShoppingListType } from '@/lib/types';
import { cn } from '@/lib/utils';
import { memberColorFromIndex, type MemberColorIndex } from '@/lib/member-colors';
import { LIST_TINT_LABELS, isListTint } from '@/lib/shopping/list-style';
import { LIST_ICON_LABELS, PRESET_LIST_ICONS, renderListIconByName } from './list-icons';

export const listSchema = z.object({
  name: z.string().trim().min(1, 'Give the list a name.').max(60, 'Keep the name under 60 characters.'),
  description: z.string().max(160, 'Keep the description under 160 characters.').optional(),
  icon: z.string().min(1, 'Pick an icon.'),
  type: z.enum(['Grocery', 'Auto', 'Hardware', 'Pets', 'Custom']),
  color: z.string().optional(),
});

export type ListFormValues = z.infer<typeof listSchema>;

const TEMPLATES: { name: string; icon: string; type: ShoppingListType; color: string }[] = [
  { name: 'Groceries', icon: 'ShoppingCart', type: 'Grocery', color: 'tint-2' },
  { name: 'Auto', icon: 'Car', type: 'Auto', color: 'tint-6' },
  { name: 'Hardware', icon: 'Wrench', type: 'Hardware', color: 'tint-4' },
  { name: 'Pet Supplies', icon: 'PawPrint', type: 'Pets', color: 'tint-7' },
];

const TINTS: MemberColorIndex[] = [1, 2, 3, 4, 5, 6, 7, 8];

export function ListDialog({
  isOpen,
  onOpenChange,
  onSave,
  listToEdit,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: ListFormValues, id?: string) => Promise<void>;
  listToEdit: ShoppingList | null;
}) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      {/* The content mounts on open, so the form starts from the list being edited. */}
      <DialogContent>
        <ListDialogBody listToEdit={listToEdit} onOpenChange={onOpenChange} onSave={onSave} />
      </DialogContent>
    </Dialog>
  );
}

function ListDialogBody({
  listToEdit,
  onOpenChange,
  onSave,
}: {
  listToEdit: ShoppingList | null;
  onOpenChange: (open: boolean) => void;
  onSave: (data: ListFormValues, id?: string) => Promise<void>;
}) {
  const [showCustomForm, setShowCustomForm] = useState(Boolean(listToEdit));
  const form = useForm<ListFormValues>({
    resolver: zodResolver(listSchema),
    defaultValues: listToEdit
      ? {
          name: listToEdit.name,
          description: listToEdit.description || '',
          icon: listToEdit.icon,
          type: listToEdit.type,
          // Older lists stored a hex color; the picker only offers palette tints.
          color: isListTint(listToEdit.color) ? listToEdit.color : '',
        }
      : { name: '', description: '', icon: 'Home', type: 'Custom', color: '' },
  });

  const handleSave = async (data: ListFormValues, id?: string) => {
    onOpenChange(false);
    await onSave(data, id);
  };

  const selectedIcon = useWatch({ control: form.control, name: 'icon' });
  const selectedColor = useWatch({ control: form.control, name: 'color' });

  return (
    <>
        <DialogHeader>
          <DialogTitle className="font-headline">{listToEdit ? 'Edit List' : 'Create New List'}</DialogTitle>
          <DialogDescription>{listToEdit ? `Update ${listToEdit.name}.` : 'Choose a template or create a custom list.'}</DialogDescription>
        </DialogHeader>

        {!showCustomForm && !listToEdit ? (
          <div className="grid grid-cols-2 gap-3 py-2">
            {TEMPLATES.map((template) => {
              const tint = memberColorFromIndex(Number(template.color.slice(5)) as MemberColorIndex);
              return (
                <Button
                  key={template.name}
                  variant="outline"
                  className="h-24 flex-col gap-2"
                  aria-label={`Create a ${template.name} list`}
                  onClick={() => void handleSave({ ...template, description: '' })}
                >
                  <span className={cn('flex h-10 w-10 items-center justify-center rounded-full', tint.classes.softChip)}>
                    {renderListIconByName(template.icon, { className: 'h-5 w-5' })}
                  </span>
                  <span>{template.name}</span>
                </Button>
              );
            })}
            <Button variant="outline" className="col-span-2 h-14 gap-2" onClick={() => setShowCustomForm(true)}>
              <PlusCircle className="h-5 w-5" aria-hidden />
              <span>Custom list</span>
            </Button>
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit((data) => handleSave(data, listToEdit?.id))} className="space-y-4">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel>List Name</FormLabel>
                  <FormControl><Input placeholder="e.g. Groceries, Home Depot" maxLength={60} {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="icon" render={() => (
                <FormItem>
                  <FormLabel>Icon</FormLabel>
                  <div role="radiogroup" aria-label="List icon" className="grid grid-cols-5 gap-2 rounded-lg border p-2 sm:grid-cols-10">
                    {PRESET_LIST_ICONS.map((iconName) => {
                      const checked = selectedIcon === iconName;
                      return (
                        <button
                          key={iconName}
                          type="button"
                          role="radio"
                          aria-checked={checked}
                          aria-label={`Use ${LIST_ICON_LABELS[iconName] ?? iconName} list icon`}
                          className={cn(
                            'flex h-10 items-center justify-center rounded-md border border-transparent transition-ui hover:bg-accent',
                            checked && 'border-primary bg-primary/10 text-primary',
                          )}
                          onClick={() => form.setValue('icon', iconName, { shouldValidate: true })}
                        >
                          {renderListIconByName(iconName, { className: 'h-5 w-5' })}
                        </button>
                      );
                    })}
                  </div>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="color" render={() => (
                <FormItem>
                  <FormLabel>Color</FormLabel>
                  <div role="radiogroup" aria-label="List color" className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={!selectedColor}
                      className={cn(
                        'h-9 rounded-full border px-3 text-sm transition-ui hover:bg-accent',
                        !selectedColor && 'border-primary bg-primary/10 text-primary',
                      )}
                      onClick={() => form.setValue('color', '')}
                    >
                      Automatic
                    </button>
                    {TINTS.map((index) => {
                      const value = `tint-${index}`;
                      const checked = selectedColor === value;
                      const tint = memberColorFromIndex(index);
                      return (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={checked}
                          aria-label={LIST_TINT_LABELS[index]}
                          className={cn(
                            'flex h-9 w-9 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-ui',
                            tint.classes.bg,
                            checked && cn('ring-2', tint.classes.ring),
                          )}
                          onClick={() => form.setValue('color', value)}
                        >
                          {checked && <Check className="h-4 w-4 text-member-foreground" aria-hidden />}
                        </button>
                      );
                    })}
                  </div>
                </FormItem>
              )} />

              <DialogFooter>
                <Button type="submit">Save List</Button>
              </DialogFooter>
            </form>
          </Form>
        )}
    </>
  );
}
