'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { format, parseISO } from 'date-fns';
import type { PantryItem, PantryItemUnit, PantryItemLocation, ShoppingList } from '@/lib/types';
import { pantryItemUnitCategories } from '@/lib/types';
import { useAuth } from '@/hooks/use-auth';
import { auth, db } from '@/lib/firebase';
import { collection, doc, deleteDoc, writeBatch, query, setDoc, updateDoc } from 'firebase/firestore';
import { awaitWriteUnlessOffline, getDocOfflineAware, getDocsOfflineAware } from '@/lib/firestore-offline';
import { DEFAULT_SHOPPING_CATEGORIES, normalizeStoredCategories } from '@/lib/shopping-items';
import { addItemsToList } from '@/lib/shopping/add-items';
import { expiryState, matchRecipeIngredients, productPhotoForName } from '@/lib/shopping/pantry';
import { pluralize } from '@/lib/shopping/items';
import { useLivePantry } from '@/lib/shopping/live';
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
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from './ui/skeleton';
import { cn } from '@/lib/utils';
import { PlusCircle, Trash2, Edit, CalendarIcon, Loader2, ScanBarcode, Plus, Minus, Sparkles, ChefHat, Clock, Salad, Check, LayoutGrid, List as ListIcon, X } from 'lucide-react';
import { buttonVariants } from './ui/button';
import { slugify } from '@/lib/utils';
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

/** AI failures already carry a public message; anything else goes through friendlyError. */
const recipeErrorMessage = (error: unknown) =>
  error instanceof AiClientError && error.message ? error.message : friendlyError(error);

const allPantryUnits = [
  ...pantryItemUnitCategories.Weight,
  ...pantryItemUnitCategories.Volume,
  ...pantryItemUnitCategories.Count,
] as [PantryItemUnit, ...PantryItemUnit[]];

const pantryItemSchema = z.object({
  name: z.string().min(1, 'Item name is required.'),
  quantity: z.coerce.number<number>().min(0, 'Quantity cannot be negative.'),
  unit: z.enum(allPantryUnits),
  location: z.enum(['Pantry', 'Fridge', 'Freezer']),
  expiryDate: z.date().optional(),
});

type PantryItemFormValues = z.infer<typeof pantryItemSchema>;

type UnitCategory = keyof typeof pantryItemUnitCategories;


function PantryItemDialog({
  isOpen,
  onOpenChange,
  onSave,
  itemToEdit,
}: {
  isOpen: boolean,
  onOpenChange: (open: boolean) => void,
  onSave: (data: PantryItemFormValues, id?: string) => Promise<boolean>,
  itemToEdit: PantryItem | null,
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
  
  const form = useForm<PantryItemFormValues>({
    resolver: zodResolver(pantryItemSchema),
    defaultValues: {
      name: '',
      quantity: 1,
      unit: 'items',
      location: 'Pantry',
      expiryDate: undefined,
    },
  });
  
  const { watch, setValue, getValues, reset } = form;
  const currentUnit = watch('unit');
  const currentQuantity = watch('quantity');

  // Determine category from a given unit
  const getCategoryFromUnit = (unit: PantryItemUnit): UnitCategory => {
    for (const [category, units] of Object.entries(pantryItemUnitCategories)) {
      if ((units as readonly string[]).includes(unit)) {
        return category as UnitCategory;
      }
    }
    return 'Count'; // Default category
  };

  // Effect to sync category when form's unit changes (e.g., when editing an item)
  useEffect(() => {
    pendingScannedUnit.current = null;
    // A lookup still running belongs to the previous opening: its answer is dropped.
    scanSessionRef.current += 1;
    scanMiss.clear();
    if (itemToEdit) {
      const category = getCategoryFromUnit(itemToEdit.unit);
      setUnitCategory(category);
      reset({
        name: itemToEdit.name,
        quantity: itemToEdit.quantity,
        unit: itemToEdit.unit,
        location: itemToEdit.location,
        expiryDate: itemToEdit.expiryDate ? parseISO(itemToEdit.expiryDate) : undefined,
      });
    } else {
      setUnitCategory('Count');
      reset({
        name: '',
        quantity: 1,
        unit: 'items',
        location: 'Pantry',
        expiryDate: undefined,
      });
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
        const { productName } = result;
        const miss = result.libraryItem ? null : lookupMiss(result);
        if (productName && !miss) {
            if (!form.formState.dirtyFields.name) form.setValue('name', productName);
            if (result.quantity && result.unit
              && !form.formState.dirtyFields.quantity
              && !form.formState.dirtyFields.unit) {
              form.setValue('quantity', result.quantity);
              pendingScannedUnit.current = result.unit;
              setUnitCategory(getCategoryFromUnit(result.unit));
            }
            toast({
              title: "Product Found!",
              description: result.quantity && result.unit
                ? `${productName}, ${result.quantity} ${result.unit}, has been filled in.`
                : `${productName} has been filled in. Enter the package quantity manually.`,
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

  const adjustQuantity = (amount: number) => {
    const currentVal = getValues('quantity');
    const newVal = Math.max(0, currentVal + amount); // Allow 0 quantity
    setValue('quantity', newVal, { shouldValidate: true });
  }

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
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-headline">{itemToEdit ? 'Edit Item' : 'Add New Item'}</DialogTitle>
          <DialogDescription>Fill in the details for your pantry item.</DialogDescription>
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
            
            <FormField
              control={form.control}
              name="quantity"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Quantity</FormLabel>
                   <div className="flex items-center gap-2">
                        <Button type="button" variant="outline" size="icon" aria-label="Decrease inventory quantity" className="h-10 w-10" onClick={() => adjustQuantity(-1)} disabled={currentQuantity <= 0}>
                            <Minus className="h-4 w-4" />
                        </Button>
                        <FormControl>
                            <Input type="number" className="text-center" {...field} />
                        </FormControl>
                         <Button type="button" variant="outline" size="icon" aria-label="Increase inventory quantity" className="h-10 w-10" onClick={() => adjustQuantity(1)}>
                            <Plus className="h-4 w-4" />
                        </Button>
                    </div>
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
                          {field.value ? format(field.value, 'PPP') : <span>Pick a date</span>}
                          <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                        </Button>
                      </FormControl>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar mode="single" selected={field.value} onSelect={field.onChange} initialFocus />
                    </PopoverContent>
                  </Popover>
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
    pantryItems,
    householdId,
    onRecipe,
}: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    pantryItems: PantryItem[];
    householdId: string;
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
    // 'lifting': the dialog and its scrim step aside so the lifted tiles are seen,
    // then 'shown': the dialog returns and the recipe card flips in.
    const [phase, setPhase] = useState<'shown' | 'lifting'>('shown');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const requestInFlight = useRef(false);
    // The pantry is live: read the items when a recipe is requested, so a snapshot
    // (even a metadata-only one) never re-creates the request and re-runs it.
    const pantryItemsRef = useRef(pantryItems);
    useEffect(() => {
        pantryItemsRef.current = pantryItems;
    }, [pantryItems]);

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
              { items: pantryItemsRef.current.map(i => ({ name: i.name, quantity: i.quantity, unit: i.unit })) },
              await getAiActionContext(householdId)
            ));
            const liftedOnScreen = onRecipe?.(result) ?? 0;
            setPhase(!reduced && liftedOnScreen > 0 ? 'lifting' : 'shown');
            setRecipe(result);
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
                            <div className="space-y-3">
                                <h3 className="font-headline text-lg font-semibold flex items-center gap-2"><Salad /> Ingredients</h3>
                                <div className="p-4 bg-secondary/50 rounded-lg">
                                    <h4 className="font-semibold mb-2">From Your Pantry</h4>
                                    <ul className="space-y-1">
                                    {recipe.ingredients.used.map(ing => (
                                        <li key={ing} className="flex items-center gap-2">
                                            <Check className="h-4 w-4 text-success" /> <span>{ing}</span>
                                        </li>
                                    ))}
                                    </ul>
                                </div>
                                {recipe.ingredients.needed.length > 0 && (
                                    <div className="p-4 bg-warning/10 rounded-lg">
                                        <h4 className="font-semibold mb-2">You Might Need</h4>
                                        <ul className="space-y-1">
                                        {recipe.ingredients.needed.map(ing => (
                                            <li key={ing} className="flex items-center gap-2">
                                                <PlusCircle className="h-4 w-4 text-warning"/> <span>{ing}</span>
                                            </li>
                                        ))}
                                        </ul>
                                    </div>
                                )}
                            </div>

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

const addItemSchema = z.object({
  name: z.string().min(1, 'Item name is required.'),
  quantity: z.coerce.number<number>().min(1, 'Quantity must be at least 1.'),
});

function AddToListDialog({
  isOpen,
  onOpenChange,
  onItemAdd,
  itemName,
  shoppingLists,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onItemAdd: (listId: string, itemName: string, quantity: number) => void;
  itemName: string;
  shoppingLists: ShoppingList[];
}) {
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const form = useForm<z.infer<typeof addItemSchema>>({
    resolver: zodResolver(addItemSchema),
    defaultValues: {
      name: itemName,
      quantity: 1,
    },
  });

  useEffect(() => {
    if (isOpen) {
      form.reset({ name: itemName, quantity: 1 });
      if (shoppingLists.length === 1) {
        setSelectedListId(shoppingLists[0].id);
      } else {
        setSelectedListId(null);
      }
    }
  }, [isOpen, itemName, shoppingLists, form]);

  const handleSubmit = (values: z.infer<typeof addItemSchema>) => {
    if (!selectedListId) return;
    onItemAdd(selectedListId, values.name, values.quantity);
    onOpenChange(false);
  };

  if (shoppingLists.length === 0) {
    // This case is handled by the parent, but as a fallback
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add &quot;{itemName}&quot; to a shopping list</DialogTitle>
          <DialogDescription>Choose the destination list and quantity for this inventory item.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            {shoppingLists.length > 1 && (
              <FormItem>
                <FormLabel>Select a List</FormLabel>
                <Select onValueChange={setSelectedListId} value={selectedListId || ''}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a shopping list..." />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {shoppingLists.map((list) => (
                      <SelectItem key={list.id} value={list.id}>
                        {list.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormItem>
            )}
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
                    <Input type="number" {...field} />
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

export function PantryInventoryClient() {
  const { currentUser, permissions } = useAuth();
  const { toast, toastError } = useToast();
  const canEdit = Boolean(permissions['shopping.edit']);
  const canDelete = Boolean(permissions['shopping.delete']);

  // Live (SH-1c): one listener on the pantry, so another member's additions, moves
  // and deletions show without a reload, and this device's own writes show at once
  // (a rejected one is rolled back in the listener). No re-read after a write.
  const pantryState = useLivePantry(currentUser?.householdId);
  const items = pantryState.value;
  const loading = pantryState.status === 'loading';
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
  const [itemToEdit, setItemToEdit] = useState<PantryItem | null>(null);
  const [itemToDelete, setItemToDelete] = useState<PantryItem | null>(null);
  const [isRecipeGenOpen, setIsRecipeGenOpen] = useState(false);

  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [isBulkDeleteAlertOpen, setIsBulkDeleteAlertOpen] = useState(false);

  const [shoppingLists, setShoppingLists] = useState<ShoppingList[]>([]);
  const [isAddToListDialogOpen, setIsAddToListDialogOpen] = useState(false);
  const [itemNameToAddToList, setItemNameToAddToList] = useState<string | null>(null);

  // Every portaled overlay of this tab closes when the tab is hidden (a tab click or
  // browser Back to the lists), so none stays on screen or traps focus there. The
  // pantry listener keeps running.
  // Bumped when the tab is hidden: a "Put on a shopping list" still reading the
  // lists then never opens its picker over the other tab.
  const addToListRequestRef = useRef(0);
  const tabActive = useOnTabDeactivate(() => {
    addToListRequestRef.current += 1;
    setIsItemDialogOpen(false);
    setItemToEdit(null);
    setItemToDelete(null);
    setIsRecipeGenOpen(false);
    setIsBulkDeleteAlertOpen(false);
    setIsAddToListDialogOpen(false);
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

  const getPantryCollectionRef = useCallback(() => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, 'pantry-inventory');
  }, [currentUser]);

  // A pantry that cannot load says so once (the listener keeps retrying).
  const reportedPantryErrorRef = useRef<unknown>(null);
  useEffect(() => {
    const error = pantryState.error;
    if (!error || reportedPantryErrorRef.current === error) return;
    reportedPantryErrorRef.current = error;
    toastError(error, 'Could not load the pantry');
  }, [pantryState.error, toastError]);

  const fetchShoppingLists = useCallback(async () => {
    if (!currentUser?.householdId) return;
    const listsCollectionRef = collection(db, 'households', currentUser.householdId, 'shopping-lists');
    const snapshot = await getDocsOfflineAware(query(listsCollectionRef));
    const lists = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ShoppingList));
    setShoppingLists(lists);
    return lists;
  }, [currentUser]);

  // Shopping lists are read on demand (when an item is put on a list).

  const photos = useMemo(() => Object.fromEntries(items.map(item => [item.id, productPhotoForName(item.name, library)])), [items, library]);

  // Stable, so the recipe dialog does not regenerate when the lifted tiles change.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  // H08: the used tiles lift first (the dialog steps aside while they do), then
  // the recipe card flips in. Returns how many lifted tiles are on screen.
  const handleRecipe = useCallback((recipe: GenerateRecipeOutput | null) => {
    const ids = recipe ? matchRecipeIngredients(recipe.ingredients.used, itemsRef.current) : [];
    setLiftedIds(new Set(ids));
    if (ids.length === 0 || viewRef.current !== 'shelves') return 0;
    requestAnimationFrame(() => {
      document.querySelector('[data-testid="pantry-shelves"] [data-lifted="true"]')?.scrollIntoView({ block: 'nearest' });
    });
    return ids.length;
  }, []);

  const handleAddToSpecificList = useCallback(async (listId: string, itemName: string, quantity: number) => {
    const householdId = currentUser?.householdId;
    if (!householdId) return;

    try {
        const categoriesDocRef = doc(db, 'households', householdId, 'shopping-lists', listId, 'config', 'categories');
        const categoriesDoc = await getDocOfflineAware(categoriesDocRef).catch(() => null);
        const categories = (categoriesDoc?.exists() ? normalizeStoredCategories(categoriesDoc.data()) : null) ?? DEFAULT_SHOPPING_CATEGORIES;

        // The Shopping list's save path: saved at once with a local category, then one
        // batched AI call. No merge here yet (SH-6 arrives with the pantry rework).
        const { outcomes, categorization } = await addItemsToList({
          householdId,
          listId,
          uid: currentUser?.uid,
          entries: [{ name: itemName, quantity }],
          categories,
          allowMerge: false,
          active: () => ({ householdId: auth.currentUser ? householdId : null, listId }),
          onLateError: (name, error) => toastError(error, `Could not sync ${name}`),
        });
        const [outcome] = outcomes;
        if (outcome.state === 'failed') throw outcome.error ?? new Error('save-failed');
        toast(outcome.state === 'saved'
          ? { title: 'Added to the list', description: `${itemName} is on your shopping list.` }
          : outcome.state === 'stored-locally'
            ? { title: 'Saved, will sync', description: `${itemName} is saved on this device and syncs when the connection is back.` }
            : { title: 'Still sending…', description: `${itemName} has not reached the list yet. An error shows here if it fails.` });
        void categorization.then((report) => {
          if (report.unavailable.length > 0) {
            toast({ title: 'Item saved to Other', description: `Automatic sorting was unavailable. ${itemName} stays under Other.` });
          }
        });
    } catch (error) {
        toastError(error, 'Could not add to the shopping list');
    }
  }, [currentUser, toast, toastError]);

  const handleSaveItem = async (data: PantryItemFormValues, id?: string): Promise<boolean> => {
    const pantryCollection = getPantryCollectionRef();
    if (!pantryCollection) return false;

    const itemData = {
      ...data,
      name: data.name.trim(),
      expiryDate: data.expiryDate ? data.expiryDate.toISOString() : null,
    };

    const itemId = id || slugify(data.name);

    try {
      const itemRef = doc(pantryCollection, itemId);
      await setDoc(itemRef, itemData, { merge: true });
      toast({ title: 'Item Saved', description: `${itemData.name} has been saved to your inventory.` });
      return true;
    } catch (error) {
      toastError(error, 'Could not save the item');
      return false;
    }
  };

  const moveItem = async (item: PantryItem, location: PantryItemLocation) => {
    const pantryCollection = getPantryCollectionRef();
    if (!pantryCollection || item.location === location) return;
    // The listener moves the tile at once; a rejected write moves it back.
    try {
      await awaitWriteUnlessOffline(updateDoc(doc(pantryCollection, item.id), { location }), (error) => {
        toastError(error, `Could not move ${item.name}`);
      });
    } catch (error) {
      toastError(error, `Could not move ${item.name}`);
    }
  };

  const handleDeleteItem = async () => {
    if (!itemToDelete) return;
    const pantryCollection = getPantryCollectionRef();
    if (!pantryCollection) return;

    try {
      await deleteDoc(doc(pantryCollection, itemToDelete.id));
      toast({ title: "Item Deleted", description: `${itemToDelete.name} removed from pantry.` });
      setItemToDelete(null);
    } catch (error) {
      toastError(error, 'Could not delete the item');
    }
  };

  const handleBulkDelete = async () => {
    const pantryCollection = getPantryCollectionRef();
    if (!pantryCollection || selectedItems.length === 0) return;

    const batch = writeBatch(db);
    selectedItems.forEach(id => {
        batch.delete(doc(pantryCollection, id));
    });

    try {
        await batch.commit();
        toast({ title: 'Items Deleted', description: `${pluralize(selectedItems.length, 'item')} removed.` });
        setSelectedItems([]);
    } catch (error) {
        toastError(error, 'Could not delete the selected items');
    } finally {
        setIsBulkDeleteAlertOpen(false);
    }
  };

  // Opens the list picker for a pantry item (Grocery lists; creates "Groceries" if there is none).
  const offerAddToList = async (itemName: string) => {
    if (!currentUser?.householdId) return;
    const request = addToListRequestRef.current;
    const allLists = await fetchShoppingLists().catch(() => undefined) ?? [];
    const groceryLists = allLists.filter(list => list.type === 'Grocery');
    // The tab was hidden while the lists loaded: drop the request.
    if (request !== addToListRequestRef.current) return;

    if (groceryLists.length === 0) {
      try {
        const listsCollectionRef = collection(db, 'households', currentUser.householdId, 'shopping-lists');
        const newListId = slugify('Groceries');
        await setDoc(doc(listsCollectionRef, newListId), { name: 'Groceries', icon: 'ShoppingCart', type: 'Grocery', description: '' });
        await handleAddToSpecificList(newListId, itemName, 1);
      } catch (error) {
        toastError(error, 'Could not create a Groceries list');
      }
    } else {
      setItemNameToAddToList(itemName);
      setIsAddToListDialogOpen(true);
    }
  };

  const handleDeleteAndAddToList = async () => {
    if (!itemToDelete || !currentUser?.householdId) return;
    const pantryCollection = getPantryCollectionRef();
    if (!pantryCollection) return;
    const originalItemName = itemToDelete.name;
    try {
      await deleteDoc(doc(pantryCollection, itemToDelete.id));
    } catch (error) {
      toastError(error, 'Could not delete the item');
      return;
    }
    setItemToDelete(null);
    await offerAddToList(originalItemName);
  };

  const openEditDialog = (item: PantryItem) => {
    setItemToEdit(item);
    setIsItemDialogOpen(true);
  };

  const openAddDialog = () => {
    setItemToEdit(null);
    setIsItemDialogOpen(true);
  };

  const handleSelectAll = (location: PantryItemLocation, isChecked: boolean | 'indeterminate') => {
    const itemIdsInLocation = items.filter(item => item.location === location).map(item => item.id);
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

  const locations: PantryItemLocation[] = ['Pantry', 'Fridge', 'Freezer'];
  const groupedItems = locations.reduce((acc, loc) => {
    acc[loc] = items.filter(item => item.location === loc);
    return acc;
  }, {} as Record<PantryItemLocation, PantryItem[]>);
  const expiringSoon = items.filter(item => expiryState(item.expiryDate) === 'soon').length;
  const expired = items.filter(item => expiryState(item.expiryDate) === 'expired').length;

  if (loading) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading the pantry">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const formatExpiry = (item: PantryItem) => {
    if (!item.expiryDate) return 'N/A';
    const date = parseISO(item.expiryDate);
    return Number.isNaN(date.getTime()) ? 'N/A' : format(date, 'PPP');
  };

  return (
    <>
      {canEdit && (
        <PantryItemDialog
          isOpen={isItemDialogOpen}
          onOpenChange={handleItemDialogClose}
          onSave={handleSaveItem}
          itemToEdit={itemToEdit}
        />
      )}
       {itemNameToAddToList && (
        <AddToListDialog
          isOpen={isAddToListDialogOpen && tabActive}
          onOpenChange={setIsAddToListDialogOpen}
          onItemAdd={handleAddToSpecificList}
          itemName={itemNameToAddToList}
          shoppingLists={shoppingLists.filter(list => list.type === 'Grocery')}
        />
      )}
      <RecipeGeneratorDialog
        isOpen={isRecipeGenOpen}
        onOpenChange={setIsRecipeGenOpen}
        pantryItems={items}
        householdId={currentUser?.householdId || ''}
        onRecipe={handleRecipe}
      />
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
                <Button className="min-w-0 px-2 text-xs sm:px-4 sm:text-sm" variant="outline" onClick={() => setIsRecipeGenOpen(true)} disabled={items.length === 0}>
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
          {items.length === 0 ? (
            <EmptyState
              kind="generic"
              title="The shelves are empty"
              description={canEdit ? 'Add what you have at home, or send items here from a finished shopping trip.' : 'Pantry items your household adds will show up here.'}
              action={canEdit ? { label: 'Stock the pantry', icon: <PlusCircle className="mr-2 h-4 w-4" aria-hidden />, onClick: openAddDialog } : undefined}
              headingLevel={3}
            />
          ) : view === 'shelves' ? (
            <PantryShelves
              items={items}
              photos={photos}
              liftedIds={liftedIds}
              canEdit={canEdit}
              canDelete={canDelete}
              onEdit={openEditDialog}
              onDelete={setItemToDelete}
              onMove={(item, location) => void moveItem(item, location)}
              onAddToList={(item) => void offerAddToList(item.name)}
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
                                                <p className="mt-1 text-xs text-muted-foreground">{item.quantity} {item.unit}</p>
                                                <p className="text-xs text-muted-foreground">Expires: {formatExpiry(item)}</p>
                                            </div>
                                            <div className="flex shrink-0 items-center">
                                                {canEdit && (
                                                  <Button variant="ghost" size="icon" aria-label={`Edit ${item.name}`} onClick={() => openEditDialog(item)}>
                                                      <Edit className="h-4 w-4" aria-hidden />
                                                  </Button>
                                                )}
                                                {canDelete && (
                                                  <Button variant="ghost" size="icon" aria-label={`Delete ${item.name}`} onClick={() => setItemToDelete(item)}>
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
                                                    <TableCell className="text-center p-2">{item.quantity} {item.unit}</TableCell>
                                                    <TableCell className="p-2">{formatExpiry(item)}</TableCell>
                                                    {(canEdit || canDelete) && (
                                                      <TableCell className="text-right p-2">
                                                          {canEdit && (
                                                            <Button variant="ghost" size="icon" aria-label={`Edit ${item.name}`} onClick={() => openEditDialog(item)}>
                                                                <Edit className="h-4 w-4" aria-hidden />
                                                            </Button>
                                                          )}
                                                          {canDelete && (
                                                            <Button variant="ghost" size="icon" aria-label={`Delete ${item.name}`} onClick={() => setItemToDelete(item)}>
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
