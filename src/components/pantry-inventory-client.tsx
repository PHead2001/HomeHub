'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { format } from 'date-fns';
import type { PantryItemUnit, PantryItemLocation, ShoppingList } from '@/lib/types';
import { pantryItemUnitCategories } from '@/lib/types';
import { useAuth } from '@/hooks/use-auth';
import { auth } from '@/lib/firebase';
import { isBrowserOffline } from '@/lib/firestore-offline';
import { daysUntilDay, EXPIRY_CHIPS, MAX_PACKAGE_SIZE, PANTRY_NAME_MAX, USED_UP_UNDO_MS, batchAmountLabel, editPackagesLimit, planAddOne, stepPackages, PantryChangeRefused, dayFromPicker, expiryFromChip, findPantryMergeTarget, groupPantryBatches, isCountUnit, pantryBatchFields, pickerDateForDay, readPantryBatch, repairEditError, repairEditPrefill, usableRecipeItems, usedUpOutcome, packageChangeToast, EMPTY_BATCH_GRACE_MS, groceryListChoice, type PantryBatch, type RecipeStockItem, type PantryBatchInput, type PantryProduct } from '@/lib/shopping/pantry-batches';
import { addToGroceryList, changePackagesTogether, createGroceriesList, readShoppingLists, deleteBatches, deleteEmptyBatchIfIdle, moveBatches, saveBatch } from '@/lib/shopping/pantry-batch-writes';
import { categorizationNotice } from '@/lib/shopping/save-status';
import { expiryStateForDays, productPhotoForName } from '@/lib/shopping/pantry';
import { recipeProductKeys } from '@/lib/shopping/recipe';
import { readRecentList, rememberRecentList } from '@/lib/shopping/recent-list';
import { pluralize } from '@/lib/shopping/items';
import { useLivePantry } from '@/lib/shopping/live';
import { pantryScanPrefill } from '@/lib/shopping/pantry-scan';
import { useHouseholdToday } from '@/lib/shopping/use-household-today';
import { useOnTabDeactivate } from './shopping/tab-activity';
import { justOpened } from '@/lib/shopping/live-state';
import { DURATION, EASE } from '@/lib/motion';
import { lookupBarcode } from '@/ai/flows/lookup-barcode-flow';
import { generateRecipe, type GenerateRecipeOutput } from '@/ai/flows/generate-recipe-flow';
import { AiClientError, getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import { friendlyError } from '@/lib/friendly-error';

import { Button } from '@/components/ui/button';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/dialog';
import { NumberTicker } from '@/components/motion/number-ticker';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from './ui/skeleton';
import { cn } from '@/lib/utils';
import { PlusCircle, Trash2, Edit, CalendarIcon, Loader2, ScanBarcode, Plus, Minus, Sparkles, ChefHat, Clock, LayoutGrid, List as ListIcon, X } from 'lucide-react';
import { buttonVariants } from './ui/button';
import { BarcodeScanner } from './barcode-scanner';
import { useLookupFeedback } from './barcode/use-lookup-feedback';
import { LookupMissNotice, useScanMiss } from './barcode/lookup-miss-notice';
import { useLibraryPhotos } from '@/lib/barcode/use-library-photos';
import { lookupMiss } from '@/lib/barcode/lookup-outcome';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import { Checkbox } from './ui/checkbox';
import { EmptyState } from './empty-state';
import { PantryShelves } from './shopping/pantry-shelves';
import { RecipeIngredients } from './shopping/recipe-ingredients';

/** AI failures already carry a public message; anything else goes through friendlyError. */
const recipeErrorMessage = (error: unknown) =>
  error instanceof AiClientError && error.message ? error.message : friendlyError(error);

const allPantryUnits = [
  ...pantryItemUnitCategories.Weight,
  ...pantryItemUnitCategories.Volume,
  ...pantryItemUnitCategories.Count,
] as [PantryItemUnit, ...PantryItemUnit[]];

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Pantry v2 (17.3): how many packages, and for weights and volumes the size of one
// package, so "used one" removes a package and never 1 g. Expiry is a date-only day.
// `maxPackages` is `editPackagesLimit`: 10,000, or a legacy count's stored total while editing it.
const pantryItemSchemaFor = (maxPackages: number) => z.object({
  name: z.string().trim().min(1, 'Item name is required.').max(PANTRY_NAME_MAX, `Keep the name to ${PANTRY_NAME_MAX} characters.`),
  packages: z.coerce.number<number>().int('Use whole packages.').min(0, 'Cannot be negative.').max(maxPackages, `At most ${maxPackages.toLocaleString()}.`),
  unit: z.enum(allPantryUnits),
  packageSize: z.string().refine(
    (value) => value.trim() === '' || (Number(value) > 0 && Number(value) <= MAX_PACKAGE_SIZE),
    `Enter a size above 0, up to ${MAX_PACKAGE_SIZE}.`,
  ),
  location: z.enum(['Pantry', 'Fridge', 'Freezer']),
  expiryDate: z.string().regex(DAY_PATTERN).nullable(),
  barcode: z.string().max(128).optional(),
});

type PantryItemFormValues = z.infer<ReturnType<typeof pantryItemSchemaFor>>;

type UnitCategory = keyof typeof pantryItemUnitCategories;

const EMPTY_FORM: PantryItemFormValues = {
  name: '', packages: 1, unit: 'items', packageSize: '', location: 'Pantry', expiryDate: null, barcode: undefined,
};

/** The batch a saved form describes (the measured size only for weights and volumes). */
const formToBatchInput = (data: PantryItemFormValues): PantryBatchInput => ({
  name: data.name,
  location: data.location,
  unit: data.unit,
  packages: data.packages,
  packageSize: isCountUnit(data.unit) || data.packageSize.trim() === '' ? null : Number(data.packageSize),
  expiryDate: data.expiryDate,
  barcode: data.barcode || null,
});

// Determine category from a given unit
const getCategoryFromUnit = (unit: PantryItemUnit): UnitCategory => {
  for (const [category, units] of Object.entries(pantryItemUnitCategories)) {
    if ((units as readonly string[]).includes(unit)) {
      return category as UnitCategory;
    }
  }
  return 'Count'; // Default category
};

function PantryItemDialog({
  isOpen,
  onOpenChange,
  onSave,
  itemToEdit,
  timeZone,
}: {
  isOpen: boolean,
  onOpenChange: (open: boolean) => void,
  onSave: (data: PantryItemFormValues, id?: string) => Promise<boolean>,
  itemToEdit: PantryBatch | null,
  timeZone?: string | null,
}) {
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  // The scanner is a sibling portaled dialog, not inside the item dialog: it closes
  // (unmounting BarcodeScanner, which releases the camera) when the Pantry tab is
  // hidden and whenever the item dialog itself closes.
  useOnTabDeactivate(() => setIsScannerOpen(false));
  if (!isOpen && isScannerOpen) setIsScannerOpen(false);
  const [unitCategory, setUnitCategory] = useState<UnitCategory>('Count');
  const pendingScannedUnit = useRef<PantryItemUnit | null>(null);
  const { toast } = useToast();
  const { currentUser, permissions } = useAuth();
  const lookupFeedback = useLookupFeedback();
  // A miss is shown inside this modal dialog (a toast's action would be unreachable).
  const scanMiss = useScanMiss();
  const scanOptions = { fallback: 'type the name instead', canSave: Boolean(permissions['shopping.edit']) };
  const scanSessionRef = useRef(0);

  const packagesLimit = editPackagesLimit(itemToEdit);
  const resolver = useMemo(() => zodResolver(pantryItemSchemaFor(packagesLimit)), [packagesLimit]);
  const form = useForm<PantryItemFormValues>({
    resolver,
    defaultValues: EMPTY_FORM,
  });

  const { watch, setValue, getValues, reset } = form;
  const currentUnit = watch('unit');
  const currentPackages = watch('packages');
  const measured = unitCategory !== 'Count';

  // Effect to sync category when form's unit changes (e.g., when editing an item)
  useEffect(() => {
    pendingScannedUnit.current = null;
    // A lookup still running belongs to the previous opening: its answer is dropped.
    scanSessionRef.current += 1;
    scanMiss.clear();
    if (itemToEdit) {
      // A batch that needs repair starts at 1 package with a suggested size, never 0 (stock kept).
      const start = itemToEdit.needsRepair ? repairEditPrefill(itemToEdit) : itemToEdit;
      setUnitCategory(getCategoryFromUnit(start.unit));
      reset({
        name: itemToEdit.name,
        packages: start.packages,
        unit: start.unit,
        packageSize: start.packageSize === null ? '' : String(start.packageSize),
        location: itemToEdit.location,
        expiryDate: itemToEdit.expiryDate,
        barcode: itemToEdit.barcode ?? undefined,
      });
    } else {
      setUnitCategory('Count');
      reset(EMPTY_FORM);
    }
  }, [itemToEdit, reset, isOpen]); // Rerun when dialog opens

  // Effect to update the unit when the category changes
  useEffect(() => {
    const unitsInCurrentCategory = pantryItemUnitCategories[unitCategory];
    if (pendingScannedUnit.current
      && (unitsInCurrentCategory as readonly PantryItemUnit[]).includes(pendingScannedUnit.current)) {
      const scannedUnit = pendingScannedUnit.current;
      pendingScannedUnit.current = null;
      setValue('unit', scannedUnit);
      return;
    }
    if (!(unitsInCurrentCategory as readonly PantryItemUnit[]).includes(currentUnit)) {
      setValue('unit', unitsInCurrentCategory[0] as PantryItemUnit);
    }
  }, [unitCategory, currentUnit, setValue]);


  const handleSubmit = async (data: PantryItemFormValues) => {
    const repairProblem = itemToEdit?.needsRepair ? repairEditError(data) : null;
    if (repairProblem) {
      form.setError(repairProblem.field, { type: 'repair', message: repairProblem.message }, { shouldFocus: true });
      return;
    }
    const success = await onSave(data, itemToEdit?.id);
    if (success) {
      onOpenChange(false);
    }
  };

  const handleBarcodeScan = async (barcode: string) => {
    const session = scanSessionRef.current;
    scanMiss.clear();
    setIsScannerOpen(false);
    toast({ title: "Barcode Scanned!", description: "Looking up product..." });
    try {
        if (!currentUser?.householdId) {
            throw new Error('No household found for barcode lookup.');
        }
        const result = unwrapAiActionResult(await lookupBarcode(
          { barcode },
          await getAiActionContext(currentUser.householdId)
        ));
        // The dialog closed or opened for another item meanwhile: never fill that form.
        if (session !== scanSessionRef.current) return;
        const miss = result.libraryItem ? null : lookupMiss(result);
        const prefill = miss ? null : pantryScanPrefill(result);
        if (prefill) {
            if (!form.formState.dirtyFields.name) form.setValue('name', prefill.name, { shouldValidate: true });
            form.setValue('barcode', barcode);
            // One package of the scanned size for weights and volumes (BL-1), the
            // count for counted units (`pantryScanPrefill`); never over a typed amount.
            const { amount } = prefill;
            if (amount
              && !form.formState.dirtyFields.packages
              && !form.formState.dirtyFields.packageSize
              && !form.formState.dirtyFields.unit) {
              form.setValue('packages', amount.packages);
              form.setValue('packageSize', amount.packageSize);
              pendingScannedUnit.current = amount.unit;
              setUnitCategory(getCategoryFromUnit(amount.unit));
            }
            toast({
              title: "Product Found!",
              description: amount
                ? `${prefill.name}, ${result.quantity} ${amount.unit}, has been filled in.`
                : `${prefill.name} has been filled in. Enter the package size yourself.`,
            });
        } else {
            // BL-9: "not found" keeps the code for "Save to library"; an outage says so.
            scanMiss.reportMiss(miss ?? { kind: 'not-found' }, barcode);
        }
    } catch (error) {
        // Inline only in the same opening; otherwise a toast (the dialog is gone).
        if (session === scanSessionRef.current) scanMiss.reportError(error, barcode);
        else lookupFeedback.reportError(error, barcode, scanOptions);
    }
  };

  const adjustPackages = (amount: number) => {
    // Never below a legacy count stored above 10,000 just by stepping (`editPackagesLimit`).
    setValue('packages', stepPackages(Number(getValues('packages')) || 0, amount, packagesLimit), { shouldValidate: true, shouldDirty: true });
  }

  const applyChip = (chip: (typeof EXPIRY_CHIPS)[number]['id']) => {
    setValue('expiryDate', expiryFromChip(chip, new Date(), timeZone), { shouldValidate: true, shouldDirty: true });
    if (chip === 'freezer3mo') setValue('location', 'Freezer', { shouldDirty: true });
  };

  return (
    <>
    <Dialog open={isScannerOpen} onOpenChange={setIsScannerOpen}>
        <DialogContent>
            <DialogHeader>
                <DialogTitle>Scan Barcode</DialogTitle>
                <DialogDescription>Scan a product barcode to prefill this inventory item.</DialogDescription>
            </DialogHeader>
            <BarcodeScanner onScan={handleBarcodeScan} />
        </DialogContent>
    </Dialog>
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-headline">{itemToEdit ? 'Edit Item' : 'Add New Item'}</DialogTitle>
          <DialogDescription>
            {itemToEdit
              ? 'Change this batch: how many packages, their size, the shelf or the expiry date.'
              : 'Adding the same item with the same size, shelf and expiry date adds to the packages already there.'}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4 py-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Item Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. All-Purpose Flour" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormItem>
              <FormLabel>Unit</FormLabel>
              <RadioGroup
                value={unitCategory}
                onValueChange={(val) => setUnitCategory(val as UnitCategory)}
                className="grid grid-cols-3 gap-4"
              >
                {Object.keys(pantryItemUnitCategories).map((cat) => (
                  <FormItem key={cat}>
                    <FormControl>
                      <RadioGroupItem value={cat} id={cat} className="sr-only peer" />
                    </FormControl>
                    <Label
                      htmlFor={cat}
                      className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary"
                    >
                      {cat}
                    </Label>
                  </FormItem>
                ))}
              </RadioGroup>
            </FormItem>

            <FormField
              control={form.control}
              name="unit"
              render={({ field }) => (
                <FormItem>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger aria-label="Unit">
                        <SelectValue placeholder="Select a unit" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {pantryItemUnitCategories[unitCategory].map(unit => (
                          <SelectItem key={unit} value={unit}>{unit}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="packages"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{measured ? 'Packages' : 'How many'}</FormLabel>
                   <div className="flex items-center gap-2">
                        <Button type="button" variant="outline" size="icon" aria-label="One package fewer" className="h-10 w-10" onClick={() => adjustPackages(-1)} disabled={Number(currentPackages) <= 0}>
                            <Minus className="h-4 w-4" />
                        </Button>
                        <FormControl>
                            <Input type="number" inputMode="numeric" min={0} step={1} className="text-center" {...field} />
                        </FormControl>
                         <Button type="button" variant="outline" size="icon" aria-label="One package more" className="h-10 w-10" onClick={() => adjustPackages(1)}>
                            <Plus className="h-4 w-4" />
                        </Button>
                    </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            {measured && (
              <FormField
                control={form.control}
                name="packageSize"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Size of one package ({currentUnit}{itemToEdit?.needsRepair ? '' : ', optional'})</FormLabel>
                    <FormControl>
                      <Input type="number" inputMode="decimal" min={0} step="any" placeholder="e.g. 450" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

             <FormField
                control={form.control}
                name="location"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Location</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a location" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="Pantry">Pantry</SelectItem>
                        <SelectItem value="Fridge">Fridge</SelectItem>
                        <SelectItem value="Freezer">Freezer</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            <FormField
              control={form.control}
              name="expiryDate"
              render={({ field }) => (
                <FormItem className="flex flex-col">
                  <FormLabel>Expiration Date (Optional)</FormLabel>
                  <div className="flex items-center gap-2">
                    <Popover>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant={"outline"}
                            className={cn(
                              "w-full pl-3 text-left font-normal",
                              !field.value && "text-muted-foreground"
                            )}
                          >
                            {field.value ? format(pickerDateForDay(field.value) ?? new Date(), 'PPP') : <span>Pick a date</span>}
                            <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        {/* The picked calendar day is stored as that day (yyyy-MM-dd), never as an instant (SH-10a). */}
                        <Calendar mode="single" selected={pickerDateForDay(field.value)} onSelect={(date) => field.onChange(date ? dayFromPicker(date) : null)} initialFocus />
                      </PopoverContent>
                    </Popover>
                    {field.value && (
                      <Button type="button" variant="ghost" size="icon" aria-label="Clear the expiration date" onClick={() => field.onChange(null)}>
                        <X className="h-4 w-4" aria-hidden />
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Quick expiry">
                    {EXPIRY_CHIPS.map((chip) => (
                      <Button key={chip.id} type="button" size="sm" variant="secondary" className="h-9 rounded-full" onClick={() => applyChip(chip.id)}>
                        {chip.label}
                      </Button>
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="outline" onClick={() => setIsScannerOpen(true)}>
                <ScanBarcode className="mr-2"/> Scan Barcode
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : 'Save Item'}
              </Button>
            </DialogFooter>
            <LookupMissNotice scanMiss={scanMiss.scanMiss} fallback="type the name instead" canSave={scanOptions.canSave} />
          </form>
        </Form>
      </DialogContent>
    </Dialog>
    </>
  );
}

/** How long the lifted tiles hold the stage before the recipe card flips in (H08). */
const RECIPE_LIFT_HOLD_MS = 450;

function RecipeGeneratorDialog({
    isOpen,
    onOpenChange,
    recipeItems,
    householdId,
    onRecipe,
    products,
    today,
    uid,
    canEdit,
}: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    /** Usable stock only (SH-27e, SH-31a): soonest expiry first, used-up, needs-repair and expired batches left out. */
    recipeItems: RecipeStockItem[];
    householdId: string;
    /** The live pantry, for the amounts on hand next to each pantry ingredient. */
    products: readonly PantryProduct[];
    today: string;
    uid: string | null;
    /** `shopping.edit`: adding missing ingredients to a list needs it. */
    canEdit: boolean;
    /**
     * Receives each generated recipe so the shelves can lift the items it uses;
     * returns how many lifted tiles are on screen (0 in the list view).
     */
    onRecipe?: (recipe: GenerateRecipeOutput | null) => number;
}) {
    const { toast } = useToast();
    const reduced = useReducedMotion();
    const [isLoading, setIsLoading] = useState(false);
    const [recipe, setRecipe] = useState<GenerateRecipeOutput | null>(null);
    // Keys the ingredients per recipe, so a new one starts with fresh add states.
    const [recipeId, setRecipeId] = useState(0);
    // 'lifting': the dialog and its scrim step aside so the lifted tiles are seen,
    // then 'shown': the dialog returns and the recipe card flips in.
    const [phase, setPhase] = useState<'shown' | 'lifting'>('shown');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const requestInFlight = useRef(false);
    // The pantry is live: read the usable items when a recipe is requested, so a
    // snapshot (even a metadata-only one) never re-creates the request and re-runs it.
    const recipeItemsRef = useRef(recipeItems);
    useEffect(() => {
        recipeItemsRef.current = recipeItems;
    }, [recipeItems]);

    const handleGenerateRecipe = useCallback(async () => {
        if (requestInFlight.current) return;
        requestInFlight.current = true;
        setIsLoading(true);
        setRecipe(null);
        setPhase('shown');
        setErrorMessage(null);
        onRecipe?.(null);
        try {
            const result = unwrapAiActionResult(await generateRecipe(
              { items: recipeItemsRef.current },
              await getAiActionContext(householdId)
            ));
            const liftedOnScreen = onRecipe?.(result) ?? 0;
            setPhase(!reduced && liftedOnScreen > 0 ? 'lifting' : 'shown');
            setRecipe(result);
            setRecipeId((id) => id + 1);
        } catch (error) {
            const message = recipeErrorMessage(error);
            console.error('Recipe generation failed', error instanceof Error ? error : String(error));
            setErrorMessage(message);
            toast({ variant: 'destructive', title: 'Generation Failed', description: message });
        } finally {
            requestInFlight.current = false;
            setIsLoading(false);
        }
    }, [householdId, toast, onRecipe, reduced]);

    // The lift holds briefly; any key or pointer press skips straight to the card.
    useEffect(() => {
        if (phase !== 'lifting') return;
        const show = () => setPhase('shown');
        const timer = window.setTimeout(show, RECIPE_LIFT_HOLD_MS);
        window.addEventListener('keydown', show, true);
        window.addEventListener('pointerdown', show, true);
        return () => {
            window.clearTimeout(timer);
            window.removeEventListener('keydown', show, true);
            window.removeEventListener('pointerdown', show, true);
        };
    }, [phase]);
    const lifting = phase === 'lifting';

    // Generate once when the dialog opens (closed -> open), never again while it
    // stays open: a new pantry snapshot or a re-created callback changes nothing,
    // so the shown recipe stays and no second AI request is made. "Try again" is
    // the way to ask for another.
    const wasOpenRef = useRef(false);
    useEffect(() => {
        const opened = justOpened(wasOpenRef.current, isOpen);
        wasOpenRef.current = isOpen;
        if (opened) void handleGenerateRecipe();
    }, [isOpen, handleGenerateRecipe]);

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            {/* DialogContent's own markup, composed here so the scrim can step aside during the lift. */}
            <DialogPortal>
            <DialogOverlay className={cn('transition-opacity duration-150', lifting && 'opacity-0')} />
            <DialogPrimitive.Content
                data-recipe-phase={phase}
                className={cn(
                    'fixed left-[50%] top-[50%] z-50 grid w-full max-w-2xl translate-x-[-50%] translate-y-[-50%] ease-spring-enter gap-4 border bg-popover p-6 text-popover-foreground shadow-overlay duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:pointer-events-none data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-xl',
                    'transition-opacity',
                    lifting && 'opacity-0',
                )}
            >
                <DialogHeader>
                    <DialogTitle className="font-headline flex items-center gap-2">
                        <Sparkles className="text-primary" />
                        AI Recipe Idea
                    </DialogTitle>
                    <DialogDescription>
                        Here&apos;s a recipe idea based on your current pantry.
                    </DialogDescription>
                </DialogHeader>

                {isLoading && (
                    <div className="flex flex-col items-center justify-center gap-4 py-16">
                        <Loader2 className="h-12 w-12 animate-spin text-primary" />
                        <p className="text-muted-foreground">Your personal AI chef is thinking...</p>
                    </div>
                )}

                {lifting && <p role="status" className="sr-only">Lifting the items this recipe uses off the shelves.</p>}
                {recipe && !lifting && (
                    // After the lift, the recipe card flips in (220 ms; instant under reduced motion).
                    <motion.div
                        data-testid="recipe-card"
                        initial={reduced ? false : { rotateX: -70, opacity: 0 }}
                        animate={{ rotateX: 0, opacity: 1 }}
                        transition={reduced ? { duration: 0 } : { duration: DURATION.ui, ease: EASE.standard }}
                        style={{ transformPerspective: 900, transformOrigin: 'top center' }}
                        className="max-h-[70vh] overflow-y-auto pr-4 space-y-6"
                    >
                        <h2 className="font-headline text-2xl font-bold text-primary">{recipe.recipeTitle}</h2>
                        <p className="text-muted-foreground">{recipe.description}</p>
                        
                        <div className="flex gap-8 text-sm">
                            <div className="flex items-center gap-2">
                                <Clock className="h-4 w-4" />
                                <div>
                                    <span className="font-semibold">Prep: </span>
                                    <span>{recipe.prepTime}</span>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <ChefHat className="h-4 w-4" />
                                <div>
                                    <span className="font-semibold">Cook: </span>
                                    <span>{recipe.cookTime}</span>
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <RecipeIngredients
                                key={recipeId}
                                ingredients={recipe.ingredients}
                                products={products}
                                today={today}
                                householdId={householdId}
                                uid={uid}
                                canEdit={canEdit}
                            />

                            <div className="space-y-3">
                                 <h3 className="font-headline text-lg font-semibold">Instructions</h3>
                                 <ol className="space-y-4">
                                    {recipe.instructions.map((step, index) => (
                                        <li key={index} className="flex gap-3">
                                            <div className="flex-shrink-0 h-6 w-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-bold">{index + 1}</div>
                                            <p>{step}</p>
                                        </li>
                                    ))}
                                 </ol>
                            </div>
                        </div>
                    </motion.div>
                )}

                {errorMessage && !isLoading && (
                    <div role="alert" className="space-y-4 rounded-md border border-destructive/40 p-4">
                        <p className="text-sm text-destructive">{errorMessage}</p>
                        <Button type="button" variant="outline" onClick={() => void handleGenerateRecipe()}>
                            Try Again
                        </Button>
                    </div>
                )}
                 <DialogFooter>
                    <Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>
                    <Button onClick={handleGenerateRecipe} disabled={isLoading}>
                       {isLoading ? <Loader2 className="mr-2 animate-spin" /> :  <><Sparkles className="mr-2" /> Regenerate</>}
                    </Button>
                </DialogFooter>
                <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none">
                    <X className="h-4 w-4" />
                    <span className="sr-only">Close</span>
                </DialogPrimitive.Close>
            </DialogPrimitive.Content>
            </DialogPortal>
        </Dialog>
    );
}

const addToListSchema = z.object({
  name: z.string().trim().min(1, 'Item name is required.'),
  quantity: z.coerce.number<number>().int('Use a whole number.').min(1, 'Quantity must be at least 1.').max(999, 'At most 999.'),
});

/**
 * The list picker for a household with several Grocery lists (SH-6). It opens on
 * the list this device used last for the pantry, else the household's default
 * Grocery list; the save goes through the Shopping merge path.
 */
function AddToListDialog({
  request,
  onOpenChange,
  onItemAdd,
}: {
  request: { name: string; lists: ShoppingList[]; preselectId: string } | null;
  onOpenChange: (open: boolean) => void;
  onItemAdd: (list: ShoppingList, itemName: string, quantity: number) => void;
}) {
  // Mounted per request (the caller keys it), so it starts from that request.
  const [selectedListId, setSelectedListId] = useState<string>(request?.preselectId ?? '');
  const form = useForm<z.infer<typeof addToListSchema>>({
    resolver: zodResolver(addToListSchema),
    defaultValues: { name: request?.name ?? '', quantity: 1 },
  });

  const handleSubmit = (values: z.infer<typeof addToListSchema>) => {
    const list = request?.lists.find((entry) => entry.id === selectedListId);
    if (!list) return;
    onItemAdd(list, values.name, values.quantity);
    onOpenChange(false);
  };

  return (
    <Dialog open={Boolean(request)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add &quot;{request?.name}&quot; to a shopping list</DialogTitle>
          <DialogDescription>Choose the Grocery list. If it is already needed there, it gets one more instead of a second entry.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormItem>
              <FormLabel>Select a List</FormLabel>
              <Select onValueChange={setSelectedListId} value={selectedListId}>
                <FormControl>
                  <SelectTrigger aria-label="Shopping list">
                    <SelectValue placeholder="Choose a shopping list..." />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {(request?.lists ?? []).map((list) => (
                    <SelectItem key={list.id} value={list.id}>{list.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormItem>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Item Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="quantity"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Quantity</FormLabel>
                  <FormControl>
                    <Input type="number" inputMode="numeric" min={1} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!selectedListId || form.formState.isSubmitting}>
                Add to List
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

const PANTRY_VIEW_KEY = 'homehub.pantry.view';
type PantryView = 'shelves' | 'list';

/** What a delete confirmation removes: one product's batches (a tile) or one batch (a list row). */
type DeleteTarget = { name: string; ids: string[] };
/** One package change of a used-up tap, kept for its Undo. */
type PackageChange = { batch: PantryBatch; delta: number };

export function PantryInventoryClient() {
  const { currentUser, household, permissions } = useAuth();
  const { toast, toastError } = useToast();
  const canEdit = Boolean(permissions['shopping.edit']);
  const canDelete = Boolean(permissions['shopping.delete']);
  const householdId = currentUser?.householdId ?? null;
  const uid = currentUser?.uid ?? null;
  // Expiry is counted in the household's zone (D-6) and re-keyed at its midnight (SH-10b).
  const timeZone = household?.timeZone ?? null;
  const today = useHouseholdToday(timeZone);

  // Live (SH-1c): one listener on the pantry, so another member's additions, moves
  // and deletions show without a reload, and this device's own writes show at once
  // (a rejected one is rolled back in the listener). No re-read after a write.
  const pantryState = useLivePantry(householdId);
  const items = pantryState.value;
  const loading = pantryState.status === 'loading';
  // Pantry v2: every document is read as a batch (legacy documents derive their
  // values); a tile groups a name's batches on one shelf; empty batches are hidden.
  const batches = useMemo(() => items.map((item) => readPantryBatch(item.id, item, timeZone)), [items, timeZone]);
  const products = useMemo(() => groupPantryBatches(batches), [batches]);
  const visibleBatches = useMemo(() => products.flatMap((product) => product.batches), [products]);
  // SH-27e / SH-31a: recipes get only usable stock (packages left, not expired), soonest expiry first.
  const recipeItems = useMemo(() => usableRecipeItems(products, today), [products, today]);

  // The chosen view is a per-device convenience (this tab only renders client-side, after sign-in).
  const [view, setView] = useState<PantryView>(() => {
    try {
      return typeof window !== 'undefined' && window.localStorage.getItem(PANTRY_VIEW_KEY) === 'list' ? 'list' : 'shelves';
    } catch {
      return 'shelves';
    }
  });
  // Product photos for tiles: the live Barcode Library (matched by name), the same source as shopping rows.
  const libraryPhotos = useLibraryPhotos(currentUser?.householdId ?? null);
  const library = useMemo(() => (libraryPhotos ? [...libraryPhotos.values()] : []), [libraryPhotos]);
  const [liftedIds, setLiftedIds] = useState<ReadonlySet<string>>(new Set());

  const [isItemDialogOpen, setIsItemDialogOpen] = useState(false);
  const [itemToEdit, setItemToEdit] = useState<PantryBatch | null>(null);
  const [itemToDelete, setItemToDelete] = useState<DeleteTarget | null>(null);
  const [isRecipeGenOpen, setIsRecipeGenOpen] = useState(false);

  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [isBulkDeleteAlertOpen, setIsBulkDeleteAlertOpen] = useState(false);

  // D-8: when a product reaches zero, ask "Add to list?" (Add / Not now). The token
  // ties the question to the tap that raised it, so that tap's Undo withdraws it.
  const [askAdd, setAskAdd] = useState<{ name: string; token: number } | null>(null);
  const askTokenRef = useRef(0);
  // SH-6: several Grocery lists open the picker; one (or none, then "Groceries") is one tap.
  const [listPick, setListPick] = useState<{ name: string; lists: ShoppingList[]; preselectId: string } | null>(null);

  // Every portaled overlay of this tab closes when the tab is hidden (a tab click or
  // browser Back to the lists), so none stays on screen or traps focus there. The
  // pantry listener keeps running.
  // Bumped when the tab is hidden: a "Put on a shopping list" still reading the
  // lists then never opens its picker over the other tab.
  const addToListRequestRef = useRef(0);
  // Bumped too: a used-up tap whose write is still pending then never opens its
  // "Add to list?" prompt over the other tab.
  const promptRequestRef = useRef(0);
  const tabActive = useOnTabDeactivate(() => {
    addToListRequestRef.current += 1;
    promptRequestRef.current += 1;
    setIsItemDialogOpen(false);
    setItemToEdit(null);
    setItemToDelete(null);
    setIsRecipeGenOpen(false);
    setIsBulkDeleteAlertOpen(false);
    setAskAdd(null);
    setListPick(null);
  });

  const changeView = (next: PantryView) => {
    setView(next);
    try {
      window.localStorage.setItem(PANTRY_VIEW_KEY, next);
    } catch {
      // Storage blocked: the choice lasts for this visit only.
    }
  };

  const handleItemDialogClose = (open: boolean) => {
    setIsItemDialogOpen(open);
    if (!open) setItemToEdit(null);
  };

  // A pantry that cannot load says so once (the listener keeps retrying).
  const reportedPantryErrorRef = useRef<unknown>(null);
  useEffect(() => {
    const error = pantryState.error;
    if (!error || reportedPantryErrorRef.current === error) return;
    reportedPantryErrorRef.current = error;
    toastError(error, 'Could not load the pantry');
  }, [pantryState.error, toastError]);

  // A used-up batch (0 packages) is hidden at once and deleted later, online, by a
  // transaction that re-checks it is still empty and untouched for a minute (an
  // Undo, a +1 or a hand-off revives it instead). Needs shopping.delete; without
  // it the empty batch just stays hidden.
  useEffect(() => {
    if (!householdId || !canDelete) return;
    const timers = batches
      // A batch that needs repair is not empty stock and is never cleaned up.
      .filter((batch) => batch.packages <= 0 && !batch.needsRepair)
      .map((batch) => {
        const idleFor = batch.updatedAtMs === null ? 0 : Date.now() - batch.updatedAtMs;
        const wait = Math.max(0, EMPTY_BATCH_GRACE_MS - idleFor) + 1000;
        return window.setTimeout(() => {
          if (isBrowserOffline()) return;
          void deleteEmptyBatchIfIdle(householdId, batch.id, timeZone).catch(() => undefined);
        }, wait);
      });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [batches, householdId, canDelete, timeZone]);


  const photos = useMemo(() => Object.fromEntries(products.map(product => [product.key, productPhotoForName(product.name, library)])), [products, library]);

  // Stable, so the recipe dialog does not regenerate when the lifted tiles change.
  const productsRef = useRef(products);
  useEffect(() => {
    productsRef.current = products;
  }, [products]);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  // H08: the used tiles lift first (the dialog steps aside while they do), then
  // the recipe card flips in. Returns how many lifted tiles are on screen.
  const handleRecipe = useCallback((recipe: GenerateRecipeOutput | null) => {
    // The pantry items the recipe names exactly (normalised on the server against the stock sent).
    const ids = recipe ? recipeProductKeys(recipe.ingredients.used, productsRef.current) : [];
    setLiftedIds(new Set(ids));
    if (ids.length === 0 || viewRef.current !== 'shelves') return 0;
    requestAnimationFrame(() => {
      document.querySelector('[data-testid="pantry-shelves"] [data-lifted="true"]')?.scrollIntoView({ block: 'nearest' });
    });
    return ids.length;
  }, []);

  /**
   * SH-6 / SH-29b: puts a product on the default Grocery list through the
   * Shopping list's merge path, so an item already needed there gets one more
   * instead of a duplicate.
   */
  const addToList = useCallback(async (list: Pick<ShoppingList, 'id' | 'name'>, name: string, quantity: number) => {
    if (!householdId) return;
    try {
      const result = await addToGroceryList({
        householdId,
        uid,
        list,
        name,
        quantity,
        active: () => ({ householdId: auth.currentUser ? householdId : null, listId: list.id }),
        onLateError: (error) => toastError(error, `Could not sync ${name}`),
      });
      if (result.state === 'failed') throw result.error ?? new Error('save-failed');
      rememberRecentList(householdId, list.id);
      const where = result.listName;
      // Only what is known (SH-4): "Saved, will sync" needs the durable cache to show the write.
      toast(result.state === 'saved'
        ? {
            title: 'On the list',
            description: result.merged ? `${result.name} was already on ${where}; it now needs ${quantity} more.` : `${name} is on ${where}.`,
          }
        : result.state === 'stored-locally'
          ? { title: 'Saved, will sync', description: `${name} is saved on this device and reaches ${where} when the connection is back.` }
          : { title: 'Still sending…', description: `${name} has not reached ${where} yet. An error shows here if it fails.` });
      void result.categorization.then((report) => {
        const notice = categorizationNotice({ savedNames: report.unavailable, unconfirmedNames: report.unconfirmed }, 'Automatic sorting was unavailable.');
        if (notice) toast(notice);
      });
    } catch (error) {
      toastError(error, 'Could not add to the shopping list');
    }
  }, [householdId, uid, toast, toastError]);

  /**
   * SH-6 / SH-29b: puts a product on a Grocery list through the Shopping list's
   * merge path, so an item already needed there gets one more instead of a
   * duplicate. One Grocery list: straight to it. Several: the picker, opened on
   * the list last used here, else the default. None: a new "Groceries" list.
   */
  const putOnList = useCallback(async (name: string) => {
    if (!householdId) return;
    const onLateError = (error: unknown) => toastError(error, `Could not sync ${name}`);
    const request = addToListRequestRef.current;
    try {
      const lists = await readShoppingLists(householdId);
      // The tab was hidden while the lists loaded: drop the request.
      if (request !== addToListRequestRef.current) return;
      const choice = groceryListChoice(lists, readRecentList(householdId));
      if (choice.kind === 'pick') {
        setListPick({ name, lists: choice.lists, preselectId: choice.preselectId });
        return;
      }
      const list = choice.kind === 'direct' ? choice.list : await createGroceriesList(householdId, onLateError);
      await addToList(list, name, 1);
    } catch (error) {
      toastError(error, 'Could not add to the shopping list');
    }
  }, [householdId, toastError, addToList]);

  const handleSaveItem = async (data: PantryItemFormValues, id?: string): Promise<boolean> => {
    if (!householdId || !uid) return false;
    const input = formToBatchInput(data);
    const fields = pantryBatchFields(input);
    if (!id && fields.packages === 0) {
      toast({ variant: 'destructive', title: 'Nothing to add', description: 'Add at least one package.' });
      return false;
    }
    // Adding stock that matches a batch exactly (name, shelf, size, unit, expiry) adds to it,
    // once saveBatch has re-checked that batch online; otherwise it becomes a separate batch.
    const mergeInto = id ? undefined : findPantryMergeTarget(batches, fields);
    try {
      const saved = await saveBatch(householdId, input, uid, { editId: id, mergeInto, timeZone }, (error) => toastError(error, `Could not sync ${fields.name}`));
      toast({
        title: saved.outcome === 'queued' ? 'Saved offline' : 'Item Saved',
        description: saved.merged
          ? `${pluralize(fields.packages, 'package')} added to ${fields.name}.`
          : `${fields.name} has been saved to your inventory.`,
      });
      return true;
    } catch (error) {
      toastError(error, 'Could not save the item');
      return false;
    }
  };

  const moveItem = async (product: PantryProduct, location: PantryItemLocation) => {
    if (!householdId || !uid || product.location === location) return;
    // The listener moves the tile at once; a rejected write moves it back.
    const onError = (error: unknown) => toastError(error, `Could not move ${product.name}`);
    try {
      await moveBatches(householdId, product.batches, location, uid, onError);
    } catch (error) {
      onError(error);
    }
  };

  // Undo (10 s, SH-29c) adds back exactly the packages the tap removed, as
  // increment(+n): after the tap every batch is in the v2 shape. It exists only
  // for a tap the server acknowledged, so the +n never outlives a refused -n.
  const undoChanges = useCallback(async (name: string, changes: PackageChange[], token: number) => {
    if (!householdId || !uid) return;
    setAskAdd((current) => (current?.token === token ? null : current));
    const onError = (error: unknown) => toastError(error, `Could not undo ${name}`);
    try {
      await changePackagesTogether(householdId, changes.map(({ batch, delta }) => ({ batch: { ...batch, legacy: false, needsRepair: false }, delta: -delta })), uid, onError, timeZone);
    } catch (error) {
      onError(error);
    }
  }, [householdId, uid, toastError, timeZone]);

  // A change refused before writing (an older item offline, an amount that needs
  // fixing, an item already gone) says why in plain words; anything else is a
  // sanitized error.
  const reportChangeError = useCallback((error: unknown, fallback: string) => {
    if (error instanceof PantryChangeRefused) {
      toast({ variant: 'destructive', title: 'Not changed', description: error.message });
      return;
    }
    toastError(error, fallback);
  }, [toast, toastError]);

  // Every change of one tap commits in one write batch (all or nothing); the Undo
  // is offered only once the server has acknowledged it (never for a write queued
  // offline: packageChangeToast), and the zero prompt once it is saved or queued.
  // A prompt whose write is still pending when the tab is hidden is dropped
  // (promptRequestRef).
  const applyChanges = async (name: string, changes: PackageChange[], reachedZero: boolean, title: string, description: string) => {
    if (!householdId || !uid || changes.length === 0) return;
    const onError = (error: unknown) => reportChangeError(error, `Could not update ${name}`);
    const request = promptRequestRef.current;
    let outcome: 'saved' | 'queued';
    let undoable: boolean;
    try {
      ({ outcome, undoable } = await changePackagesTogether(householdId, changes, uid, onError, timeZone));
    } catch (error) {
      onError(error);
      return;
    }
    const token = ++askTokenRef.current;
    // Undo only for a write the server acknowledged; a queued offline write gets no Undo
    // (a queued +n could apply even though the queued -n is refused on reconnect).
    // Undo also needs to fit the 10,000 per batch (an older count above it emptied at once does not).
    const shown = packageChangeToast(outcome, title, description);
    if (shown.offerUndo && undoable) {
      const handle = toast({
        title: shown.title,
        description: shown.description,
        duration: USED_UP_UNDO_MS,
        action: (
          <ToastAction altText={`Undo: ${title}`} onClick={() => { handle.dismiss(); void undoChanges(name, changes, token); }}>
            Undo
          </ToastAction>
        ),
      });
    } else {
      toast({ title: shown.title, description: shown.description });
    }
    if (reachedZero && request === promptRequestRef.current) setAskAdd({ name, token });
  };

  // SH-22a / SH-29a: one package from the soonest-expiring batch, never 1 g of a measured amount.
  const takeOne = (product: PantryProduct) => {
    const outcome = usedUpOutcome(product);
    if (!outcome) return;
    void applyChanges(
      product.name,
      [{ batch: outcome.batch, delta: -1 }],
      outcome.askAddToList,
      `Used one ${product.name}`,
      outcome.remaining === 0 ? 'That was the last one.' : `${pluralize(outcome.remaining, 'package')} left.`,
    );
  };

  // SH-29: "Out of this" uses every package up, then asks "Add to list?".
  const outOfThis = (product: PantryProduct) => {
    void applyChanges(
      product.name,
      product.batches.filter((batch) => batch.packages > 0).map((batch) => ({ batch, delta: -batch.packages })),
      true,
      `Out of ${product.name}`,
      'Marked as used up.',
    );
  };

  // SH-22b's counterpart: one more package of the soonest batch; when that batch
  // is full (10,000), a same-key batch with room or a new overflow batch (`planAddOne`).
  const addOne = (product: PantryProduct) => {
    const plan = planAddOne(product.batches);
    if (!householdId || !uid || !plan) return;
    const onError = (error: unknown) => reportChangeError(error, `Could not update ${product.name}`);
    if (plan.kind === 'increment') {
      changePackagesTogether(householdId, [{ batch: plan.batch, delta: 1 }], uid, onError, timeZone).catch(onError);
    } else {
      saveBatch(householdId, plan.input, uid, { mergeInto: plan.full, timeZone }, onError).catch(onError);
    }
  };

  const handleDeleteItem = async () => {
    if (!itemToDelete || !householdId) return;
    try {
      await deleteBatches(householdId, itemToDelete.ids);
      toast({ title: "Item Deleted", description: `${itemToDelete.name} removed from pantry.` });
      setItemToDelete(null);
    } catch (error) {
      toastError(error, 'Could not delete the item');
    }
  };

  const handleBulkDelete = async () => {
    if (!householdId || selectedItems.length === 0) return;
    try {
        await deleteBatches(householdId, selectedItems);
        toast({ title: 'Items Deleted', description: `${pluralize(selectedItems.length, 'item')} removed.` });
        setSelectedItems([]);
    } catch (error) {
        toastError(error, 'Could not delete the selected items');
    } finally {
        setIsBulkDeleteAlertOpen(false);
    }
  };

  const handleDeleteAndAddToList = async () => {
    if (!itemToDelete || !householdId) return;
    const originalItemName = itemToDelete.name;
    try {
      await deleteBatches(householdId, itemToDelete.ids);
    } catch (error) {
      toastError(error, 'Could not delete the item');
      return;
    }
    setItemToDelete(null);
    await putOnList(originalItemName);
  };

  const openEditDialog = (batch: PantryBatch) => {
    setItemToEdit(batch);
    setIsItemDialogOpen(true);
  };

  const openAddDialog = () => {
    setItemToEdit(null);
    setIsItemDialogOpen(true);
  };

  const locations: PantryItemLocation[] = ['Pantry', 'Fridge', 'Freezer'];
  const groupedItems = locations.reduce((acc, loc) => {
    acc[loc] = visibleBatches.filter(item => item.location === loc);
    return acc;
  }, {} as Record<PantryItemLocation, PantryBatch[]>);

  const handleSelectAll = (location: PantryItemLocation, isChecked: boolean | 'indeterminate') => {
    const itemIdsInLocation = groupedItems[location].map(item => item.id);
    if (isChecked) {
        setSelectedItems(prev => [...new Set([...prev, ...itemIdsInLocation])]);
    } else {
        setSelectedItems(prev => prev.filter(id => !itemIdsInLocation.includes(id)));
    }
  };

  const handleItemSelect = (itemId: string, isChecked: boolean) => {
    setSelectedItems(prev => {
        if (isChecked) {
            return [...prev, itemId];
        } else {
            return prev.filter(id => id !== itemId);
        }
    });
  };

  const productState = (product: PantryProduct) => expiryStateForDays(daysUntilDay(product.nextExpiry, today, timeZone));
  const expiringSoon = products.filter(product => productState(product) === 'soon').length;
  const expired = products.filter(product => productState(product) === 'expired').length;

  if (loading) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading the pantry">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const formatExpiry = (item: PantryBatch) => {
    const date = pickerDateForDay(item.expiryDate);
    return date ? format(date, 'PPP') : 'N/A';
  };

  return (
    <>
      {canEdit && (
        <PantryItemDialog
          isOpen={isItemDialogOpen}
          onOpenChange={handleItemDialogClose}
          onSave={handleSaveItem}
          itemToEdit={itemToEdit}
          timeZone={timeZone}
        />
      )}
      <RecipeGeneratorDialog
        isOpen={isRecipeGenOpen}
        onOpenChange={setIsRecipeGenOpen}
        recipeItems={recipeItems}
        householdId={householdId || ''}
        onRecipe={handleRecipe}
        products={products}
        today={today}
        uid={uid}
        canEdit={canEdit}
      />
      <AddToListDialog
        key={listPick ? `pick:${listPick.name}:${listPick.preselectId}` : 'closed'}
        request={tabActive ? listPick : null}
        onOpenChange={(open) => !open && setListPick(null)}
        onItemAdd={(list, itemName, quantity) => void addToList(list, itemName, quantity)}
      />
      <AlertDialog open={tabActive && !!askAdd} onOpenChange={(open) => !open && setAskAdd(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add {askAdd?.name} to the list?</AlertDialogTitle>
            <AlertDialogDescription>
              That was the last of it. Put it on a Grocery list?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const name = askAdd?.name; setAskAdd(null); if (name) void putOnList(name); }}>
              Add
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!itemToDelete} onOpenChange={(open) => !open && setItemToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {itemToDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the item from your inventory.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={handleDeleteItem}>
              Delete Only
            </AlertDialogAction>
            {canEdit && (
              <AlertDialogAction onClick={handleDeleteAndAddToList}>
                Delete & Add to List
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

       <AlertDialog open={isBulkDeleteAlertOpen} onOpenChange={setIsBulkDeleteAlertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pluralize(selectedItems.length, 'item')}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove them from your inventory. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={handleBulkDelete}>
              Delete Items
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card className="min-w-0">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <CardTitle className="font-headline">Pantry Inventory</CardTitle>
              {(expiringSoon > 0 || expired > 0) && (
                <p className="mt-1 text-sm">
                  {expiringSoon > 0 && <span className="text-warning"><NumberTicker value={expiringSoon} animateOnMount={false} /> {expiringSoon === 1 ? 'item' : 'items'} expiring soon</span>}
                  {expiringSoon > 0 && expired > 0 && <span className="text-muted-foreground"> · </span>}
                  {expired > 0 && <span className="text-destructive"><NumberTicker value={expired} animateOnMount={false} /> expired</span>}
                </p>
              )}
            </div>
            <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center">
                 {view === 'list' && canDelete && selectedItems.length > 0 && (
                    <Button className="col-span-2 sm:order-last" variant="destructive" onClick={() => setIsBulkDeleteAlertOpen(true)}>
                        <Trash2 className="mr-2 h-4 w-4" aria-hidden /> Delete Selected ({selectedItems.length})
                    </Button>
                )}
                <div role="group" aria-label="Pantry view" className="col-span-2 flex rounded-md border p-0.5 sm:col-span-1">
                  <Button
                    type="button"
                    size="sm"
                    variant={view === 'shelves' ? 'secondary' : 'ghost'}
                    aria-pressed={view === 'shelves'}
                    aria-label="Shelves view"
                    className="flex-1"
                    onClick={() => changeView('shelves')}
                  >
                    <LayoutGrid className="mr-1.5 h-4 w-4" aria-hidden /> Shelves
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={view === 'list' ? 'secondary' : 'ghost'}
                    aria-pressed={view === 'list'}
                    aria-label="List view"
                    className="flex-1"
                    onClick={() => changeView('list')}
                  >
                    <ListIcon className="mr-1.5 h-4 w-4" aria-hidden /> List
                  </Button>
                </div>
                {/* The recipe server needs at least two usable items (SH-10, SH-27e). */}
                <Button className="min-w-0 px-2 text-xs sm:px-4 sm:text-sm" variant="outline" onClick={() => setIsRecipeGenOpen(true)} disabled={recipeItems.length < 2}>
                    <Sparkles className="mr-1 h-4 w-4 shrink-0 sm:mr-2" aria-hidden /> Generate Recipe
                </Button>
                {canEdit && (
                  <Button className="min-w-0 px-2 text-xs sm:px-4 sm:text-sm" onClick={openAddDialog}>
                      <PlusCircle className="mr-1 h-4 w-4 shrink-0 sm:mr-2" aria-hidden /> Add Item
                  </Button>
                )}
            </div>
        </CardHeader>
        <CardContent className="min-w-0 px-3 sm:px-6">
          {products.length === 0 ? (
            <EmptyState
              kind="generic"
              title="The shelves are empty"
              description={canEdit ? 'Add what you have at home, or send items here from a finished shopping trip.' : 'Pantry items your household adds will show up here.'}
              action={canEdit ? { label: 'Stock the pantry', icon: <PlusCircle className="mr-2 h-4 w-4" aria-hidden />, onClick: openAddDialog } : undefined}
              headingLevel={3}
            />
          ) : view === 'shelves' ? (
            <PantryShelves
              items={products}
              photos={photos}
              liftedIds={liftedIds}
              today={today}
              timeZone={timeZone}
              canEdit={canEdit}
              canDelete={canDelete}
              onEdit={openEditDialog}
              onDelete={(product) => setItemToDelete({ name: product.name, ids: product.batches.map((batch) => batch.id) })}
              onMove={(product, location) => void moveItem(product, location)}
              onAddToList={(product) => void putOnList(product.name)}
              onUseOne={takeOne}
              onAddOne={addOne}
              onOutOfThis={outOfThis}
            />
          ) : (
            <Accordion type="multiple" defaultValue={['Pantry', 'Fridge', 'Freezer']} className="w-full space-y-2">
                {locations.map(loc => {
                    const itemsInLocation = groupedItems[loc];
                    const selectedInLocation = itemsInLocation.filter(item => selectedItems.includes(item.id)).length;
                    const allInLocationSelected = itemsInLocation.length > 0 && selectedInLocation === itemsInLocation.length;
                    const someInLocationSelected = selectedInLocation > 0 && selectedInLocation < itemsInLocation.length;

                    return (
                        <AccordionItem value={loc} key={loc} className="min-w-0 rounded-lg border bg-background px-3 sm:px-4">
                            <AccordionTrigger className="hover:no-underline font-headline text-lg">
                                <span>{loc} (<NumberTicker value={itemsInLocation.length} animateOnMount={false} />)</span>
                            </AccordionTrigger>
                            <AccordionContent>
                                <div className="divide-y sm:hidden" data-testid={`mobile-inventory-${loc.toLowerCase()}`}>
                                    {itemsInLocation.length > 0 ? itemsInLocation.map(item => (
                                        <div key={item.id} className="flex min-w-0 items-start gap-3 py-3" data-state={selectedItems.includes(item.id) && "selected"}>
                                            {canDelete && (
                                              <Checkbox
                                                  checked={selectedItems.includes(item.id)}
                                                  onCheckedChange={(checked) => handleItemSelect(item.id, !!checked)}
                                                  aria-label={`Select ${item.name}`}
                                                  className="mt-1 shrink-0"
                                              />
                                            )}
                                            <div className="min-w-0 flex-1">
                                                <p className="break-words text-sm font-medium">{item.name}</p>
                                                <p className="mt-1 text-xs text-muted-foreground">{batchAmountLabel(item)}</p>
                                                <p className="text-xs text-muted-foreground">Expires: {formatExpiry(item)}</p>
                                            </div>
                                            <div className="flex shrink-0 items-center">
                                                {canEdit && (
                                                  <Button variant="ghost" size="icon" aria-label={`Edit ${item.name}`} onClick={() => openEditDialog(item)}>
                                                      <Edit className="h-4 w-4" aria-hidden />
                                                  </Button>
                                                )}
                                                {canDelete && (
                                                  <Button variant="ghost" size="icon" aria-label={`Delete ${item.name}`} onClick={() => setItemToDelete({ name: item.name, ids: [item.id] })}>
                                                      <Trash2 className="h-4 w-4" aria-hidden />
                                                  </Button>
                                                )}
                                            </div>
                                        </div>
                                    )) : (
                                        <p className="py-8 text-center text-sm text-muted-foreground">No items in {loc}.</p>
                                    )}
                                </div>
                                <div className="hidden sm:block">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            {canDelete && (
                                              <TableHead className="w-10 p-2">
                                                   <Checkbox
                                                      checked={allInLocationSelected ? true : someInLocationSelected ? 'indeterminate' : false}
                                                      onCheckedChange={(checked) => handleSelectAll(loc, !!checked)}
                                                      aria-label={`Select all items in ${loc}`}
                                                      disabled={itemsInLocation.length === 0}
                                                  />
                                              </TableHead>
                                            )}
                                            <TableHead>Name</TableHead>
                                            <TableHead className="text-center">Quantity</TableHead>
                                            <TableHead>Expires</TableHead>
                                            {(canEdit || canDelete) && <TableHead className="text-right">Actions</TableHead>}
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {itemsInLocation.length > 0 ? (
                                            itemsInLocation.map(item => (
                                                <TableRow key={item.id} data-state={selectedItems.includes(item.id) && "selected"}>
                                                    {canDelete && (
                                                      <TableCell className="p-2">
                                                          <Checkbox
                                                              checked={selectedItems.includes(item.id)}
                                                              onCheckedChange={(checked) => handleItemSelect(item.id, !!checked)}
                                                              aria-label={`Select ${item.name}`}
                                                          />
                                                      </TableCell>
                                                    )}
                                                    <TableCell className="font-medium p-2">{item.name}</TableCell>
                                                    <TableCell className="text-center p-2">{batchAmountLabel(item)}</TableCell>
                                                    <TableCell className="p-2">{formatExpiry(item)}</TableCell>
                                                    {(canEdit || canDelete) && (
                                                      <TableCell className="text-right p-2">
                                                          {canEdit && (
                                                            <Button variant="ghost" size="icon" aria-label={`Edit ${item.name}`} onClick={() => openEditDialog(item)}>
                                                                <Edit className="h-4 w-4" aria-hidden />
                                                            </Button>
                                                          )}
                                                          {canDelete && (
                                                            <Button variant="ghost" size="icon" aria-label={`Delete ${item.name}`} onClick={() => setItemToDelete({ name: item.name, ids: [item.id] })}>
                                                                <Trash2 className="h-4 w-4" aria-hidden />
                                                            </Button>
                                                          )}
                                                      </TableCell>
                                                    )}
                                                </TableRow>
                                            ))
                                        ) : (
                                            <TableRow>
                                                <TableCell colSpan={5} className="text-center text-muted-foreground h-24">No items in {loc}.</TableCell>
                                            </TableRow>
                                        )}
                                    </TableBody>
                                </Table>
                                </div>
                            </AccordionContent>
                        </AccordionItem>
                    );
                })}
            </Accordion>
          )}
        </CardContent>
      </Card>
    </>
  );
}
