

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { format, parseISO } from 'date-fns';
import type { PantryItem, PantryItemUnit, PantryItemLocation, ShoppingList, ShoppingListType } from '@/lib/types';
import { pantryItemUnitCategories } from '@/lib/types';
import { useAuth } from '@/hooks/use-auth';
import { db } from '@/lib/firebase';
import { collection, doc, getDocs, updateDoc, deleteDoc, writeBatch, query, orderBy, getDoc, setDoc, collectionGroup } from 'firebase/firestore';
import { categorizeGroceryItem } from '@/ai/flows/categorize-grocery-item-flow';
import { lookupBarcode } from '@/ai/flows/lookup-barcode-flow';
import { generateRecipe, type GenerateRecipeOutput } from '@/ai/flows/generate-recipe-flow';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { PlusCircle, Trash2, Edit, CalendarIcon, Loader2, ShoppingCart, ScanBarcode, Plus, Minus, Sparkles, ChefHat, Clock, Salad, Check } from 'lucide-react';
import { buttonVariants } from './ui/button';
import { slugify } from '@/lib/utils';
import { BarcodeScanner } from './barcode-scanner';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import { Checkbox } from './ui/checkbox';

const allPantryUnits = [
  ...pantryItemUnitCategories.Weight,
  ...pantryItemUnitCategories.Volume,
  ...pantryItemUnitCategories.Count,
] as [PantryItemUnit, ...PantryItemUnit[]];

const pantryItemSchema = z.object({
  name: z.string().min(1, 'Item name is required.'),
  quantity: z.coerce.number().min(0, 'Quantity cannot be negative.'),
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
  const [unitCategory, setUnitCategory] = useState<UnitCategory>('Count');
  const { toast } = useToast();
  const { currentUser } = useAuth();
  
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
    setIsScannerOpen(false);
    toast({ title: "Barcode Scanned!", description: "Looking up product..." });
    try {
        if (!currentUser?.householdId) {
            throw new Error('No household found for barcode lookup.');
        }
        const { productName } = await lookupBarcode({ barcode, householdId: currentUser.householdId });
        if (productName) {
            form.setValue('name', productName);
            toast({ title: "Product Found!", description: `${productName} has been filled in.`});
        } else {
            toast({ variant: 'destructive', title: 'Product Not Found', description: 'Could not find a product for that barcode.' });
        }
    } catch (error) {
        console.error(error);
        toast({ variant: 'destructive', title: 'Lookup Failed', description: 'An error occurred while looking up the barcode.' });
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
                        <Button type="button" variant="outline" size="icon" className="h-10 w-10" onClick={() => adjustQuantity(-1)} disabled={currentQuantity <= 0}>
                            <Minus className="h-4 w-4" />
                        </Button>
                        <FormControl>
                            <Input type="number" className="text-center" {...field} />
                        </FormControl>
                         <Button type="button" variant="outline" size="icon" className="h-10 w-10" onClick={() => adjustQuantity(1)}>
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
                      <SelectTrigger>
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
          </form>
        </Form>
      </DialogContent>
    </Dialog>
    </>
  );
}

function RecipeGeneratorDialog({
    isOpen,
    onOpenChange,
    pantryItems
}: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    pantryItems: PantryItem[];
}) {
    const { toast } = useToast();
    const [isLoading, setIsLoading] = useState(false);
    const [recipe, setRecipe] = useState<GenerateRecipeOutput | null>(null);

    const handleGenerateRecipe = useCallback(async () => {
        setIsLoading(true);
        setRecipe(null);
        try {
            const result = await generateRecipe({ items: pantryItems.map(i => ({ name: i.name, quantity: i.quantity, unit: i.unit })) });
            setRecipe(result);
        } catch (error: any) {
            console.error("Error generating recipe: ", error);
            toast({ variant: 'destructive', title: "Generation Failed", description: error.message || "Could not generate a recipe." });
            onOpenChange(false); // Close dialog on error
        } finally {
            setIsLoading(false);
        }
    }, [pantryItems, onOpenChange, toast]);

    // Automatically trigger generation when dialog opens
    useEffect(() => {
        if (isOpen) {
            handleGenerateRecipe();
        }
    }, [isOpen, handleGenerateRecipe]);

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle className="font-headline flex items-center gap-2">
                        <Sparkles className="text-primary" />
                        AI Recipe Idea
                    </DialogTitle>
                    <DialogDescription>
                        Here's a recipe idea based on your current pantry.
                    </DialogDescription>
                </DialogHeader>

                {isLoading && (
                    <div className="flex flex-col items-center justify-center gap-4 py-16">
                        <Loader2 className="h-12 w-12 animate-spin text-primary" />
                        <p className="text-muted-foreground">Your personal AI chef is thinking...</p>
                    </div>
                )}

                {recipe && (
                    <div className="max-h-[70vh] overflow-y-auto pr-4 space-y-6">
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
                                            <Check className="h-4 w-4 text-green-500" /> <span>{ing}</span>
                                        </li>
                                    ))}
                                    </ul>
                                </div>
                                {recipe.ingredients.needed.length > 0 && (
                                    <div className="p-4 bg-amber-500/10 rounded-lg">
                                        <h4 className="font-semibold mb-2">You Might Need</h4>
                                        <ul className="space-y-1">
                                        {recipe.ingredients.needed.map(ing => (
                                            <li key={ing} className="flex items-center gap-2">
                                                <PlusCircle className="h-4 w-4 text-amber-600"/> <span>{ing}</span>
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
                    </div>
                )}
                 <DialogFooter>
                    <Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>
                    <Button onClick={handleGenerateRecipe} disabled={isLoading}>
                       {isLoading ? <Loader2 className="mr-2 animate-spin" /> :  <><Sparkles className="mr-2" /> Regenerate</>}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

const addItemSchema = z.object({
  name: z.string().min(1, 'Item name is required.'),
  quantity: z.coerce.number().min(1, 'Quantity must be at least 1.'),
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
          <DialogTitle>Add "{itemName}" to a shopping list</DialogTitle>
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


export function PantryInventoryClient({ itemToAddToPantry, onFinishAddingToPantry }: { itemToAddToPantry: PantryItem | null, onFinishAddingToPantry: () => void }) {
  const { currentUser } = useAuth();
  const { toast } = useToast();

  const [items, setItems] = useState<PantryItem[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [isItemDialogOpen, setIsItemDialogOpen] = useState(false);
  const [itemToEdit, setItemToEdit] = useState<PantryItem | null>(null);
  const [itemToDelete, setItemToDelete] = useState<PantryItem | null>(null);
  const [isRecipeGenOpen, setIsRecipeGenOpen] = useState(false);
  
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [isBulkDeleteAlertOpen, setIsBulkDeleteAlertOpen] = useState(false);

  const [shoppingLists, setShoppingLists] = useState<ShoppingList[]>([]);
  const [isAddToListDialogOpen, setIsAddToListDialogOpen] = useState(false);
  const [itemNameToAddToList, setItemNameToAddToList] = useState<string | null>(null);


  useEffect(() => {
    if (itemToAddToPantry) {
      setItemToEdit(itemToAddToPantry);
      setIsItemDialogOpen(true);
    }
  }, [itemToAddToPantry]);
  
  const handleItemDialogClose = (open: boolean) => {
    setIsItemDialogOpen(open);
    if (!open) {
      if (itemToAddToPantry) {
        onFinishAddingToPantry();
      }
      setItemToEdit(null);
    }
  }

  const getPantryCollectionRef = useCallback(() => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, 'pantry-inventory');
  }, [currentUser]);

  const fetchItems = useCallback(async () => {
    const pantryCollection = getPantryCollectionRef();
    if (!pantryCollection) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const q = query(pantryCollection, orderBy('name'));
      const querySnapshot = await getDocs(q);
      const itemsData = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as PantryItem));
      setItems(itemsData);
    } catch (error) {
      console.error("Error fetching pantry items:", error);
      toast({ variant: 'destructive', title: 'Error', description: 'Could not fetch pantry items.' });
    } finally {
      setLoading(false);
    }
  }, [getPantryCollectionRef, toast]);
  
  const fetchShoppingLists = useCallback(async () => {
    if (!currentUser?.householdId) return;
    const listsCollectionRef = collection(db, 'households', currentUser.householdId, 'shopping-lists');
    const snapshot = await getDocs(listsCollectionRef);
    const lists = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ShoppingList));
    setShoppingLists(lists);
    return lists;
  }, [currentUser]);


  useEffect(() => {
    if (currentUser?.householdId) {
      fetchItems();
      fetchShoppingLists();
    }
  }, [currentUser, fetchItems, fetchShoppingLists]);
  
  const handleAddToSpecificList = useCallback(async (listId: string, itemName: string, quantity: number) => {
    if (!currentUser?.householdId) return;

    toast({ title: "Adding to list...", description: `Categorizing ${itemName}...` });
    try {
        const listItemsCollectionRef = collection(db, 'households', currentUser.householdId, 'shopping-lists', listId, 'items');
        const categoriesDocRef = doc(db, 'households', currentUser.householdId, 'shopping-lists', listId, 'config', 'categories');
        
        const categoriesDoc = await getDoc(categoriesDocRef);
        const defaultCategories = ['Produce', 'Dairy', 'Meat', 'Bakery', 'Pantry', 'Frozen', 'Snacks', 'Drinks', 'Household', 'Other'];
        const categories = categoriesDoc.exists() && categoriesDoc.data().list ? categoriesDoc.data().list : defaultCategories;

        const result = await categorizeGroceryItem({ itemName, categories });
        
        const newItem = {
            name: itemName,
            quantity: quantity,
            category: result.category,
            createdAt: new Date(),
            status: 'needed',
        };

        const itemId = slugify(itemName);
        await setDoc(doc(listItemsCollectionRef, itemId), newItem);
        toast({ title: "Item Added!", description: `${itemName} was added to your shopping list.`});
    } catch (error) {
        console.error('Failed to add to grocery list:', error);
        toast({ variant: 'destructive', title: 'Error', description: 'Could not add item to shopping list.' });
    }
  }, [currentUser, toast]);


  const handleSaveItem = async (data: PantryItemFormValues, id?: string): Promise<boolean> => {
    const pantryCollection = getPantryCollectionRef();
    if (!pantryCollection) return false;

    const itemData = {
      ...data,
      expiryDate: data.expiryDate ? data.expiryDate.toISOString() : null,
    };
    
    const itemId = id || slugify(data.name);

    try {
      const itemRef = doc(pantryCollection, itemId);
      await setDoc(itemRef, itemData, { merge: true });
      
      toast({ title: 'Item Saved', description: `${data.name} has been saved to your inventory.` });
      
      await fetchItems();
      
      if (itemToAddToPantry) {
        onFinishAddingToPantry();
      }
      return true;

    } catch (error) {
      console.error('Error saving item:', error);
      toast({ variant: 'destructive', title: 'Error', description: 'Could not save item.' });
      return false;
    }
  };
  
  const handleDeleteItem = async () => {
    if (!itemToDelete) return;
    const pantryCollection = getPantryCollectionRef();
    if (!pantryCollection) return;

    try {
      await deleteDoc(doc(pantryCollection, itemToDelete.id));
      await fetchItems();
      toast({ title: "Item Deleted", description: `${itemToDelete.name} removed from pantry.` });
      setItemToDelete(null);
    } catch (error) {
      console.error('Error deleting item:', error);
      toast({ variant: 'destructive', title: 'Error', description: 'Could not delete item.' });
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
        toast({ title: 'Items Deleted', description: `${selectedItems.length} items have been removed.` });
        await fetchItems();
        setSelectedItems([]);
    } catch (error) {
        console.error('Error bulk deleting items:', error);
        toast({ variant: 'destructive', title: 'Error', description: 'Could not delete selected items.' });
    } finally {
        setIsBulkDeleteAlertOpen(false);
    }
  };

  const handleDeleteAndAddToList = async () => {
    if (!itemToDelete || !currentUser?.householdId) return;

    const pantryCollection = getPantryCollectionRef();
    if (!pantryCollection) return;
    
    const originalItemName = itemToDelete.name;

    // Delete item from pantry first
    await deleteDoc(doc(pantryCollection, itemToDelete.id));
    await fetchItems();
    setItemToDelete(null); // Close the delete confirmation

    // Then handle adding to a list
    const allLists = await fetchShoppingLists() ?? [];
    const groceryLists = allLists.filter(list => list.type === 'Grocery');

    if (groceryLists.length === 0) {
      // Create a default list and add to it
      const listsCollectionRef = collection(db, 'households', currentUser.householdId, 'shopping-lists');
      const newListId = slugify('Groceries');
      await setDoc(doc(listsCollectionRef, newListId), { name: 'Groceries', icon: 'ShoppingCart', type: 'Grocery' });
      await handleAddToSpecificList(newListId, originalItemName, 1);
    } else {
      // Open dialog to select/add to a list
      setItemNameToAddToList(originalItemName);
      setIsAddToListDialogOpen(true);
    }
  };

  const openEditDialog = (item: PantryItem) => {
    setItemToEdit(item);
    setIsItemDialogOpen(true);
  };
  
  const openAddDialog = () => {
    setItemToEdit(null);
    setIsItemDialogOpen(true);
  }
  
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

  if (loading) {
    return <Skeleton className="h-64 w-full" />;
  }
  
  return (
    <>
      <PantryItemDialog 
        isOpen={isItemDialogOpen}
        onOpenChange={handleItemDialogClose}
        onSave={handleSaveItem}
        itemToEdit={itemToEdit}
      />
       {itemNameToAddToList && (
        <AddToListDialog
          isOpen={isAddToListDialogOpen}
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
            <AlertDialogAction onClick={handleDeleteAndAddToList}>
              Delete & Add to List
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      
       <AlertDialog open={isBulkDeleteAlertOpen} onOpenChange={setIsBulkDeleteAlertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action will permanently delete {selectedItems.length} items from your inventory. This cannot be undone.
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

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="font-headline">Pantry Inventory</CardTitle>
            <div className="flex items-center gap-2">
                 {selectedItems.length > 0 && (
                    <Button variant="destructive" onClick={() => setIsBulkDeleteAlertOpen(true)}>
                        <Trash2 className="mr-2" /> Delete Selected ({selectedItems.length})
                    </Button>
                )}
                <Button variant="outline" onClick={() => setIsRecipeGenOpen(true)} disabled={items.length === 0}>
                    <Sparkles className="mr-2" /> Generate Recipe
                </Button>
                <Button onClick={openAddDialog}>
                    <PlusCircle className="mr-2" /> Add Item
                </Button>
            </div>
        </CardHeader>
        <CardContent>
            <Accordion type="multiple" defaultValue={['Pantry', 'Fridge', 'Freezer']} className="w-full space-y-2">
                {locations.map(loc => {
                    const itemsInLocation = groupedItems[loc];
                    const selectedInLocation = itemsInLocation.filter(item => selectedItems.includes(item.id)).length;
                    const allInLocationSelected = itemsInLocation.length > 0 && selectedInLocation === itemsInLocation.length;
                    const someInLocationSelected = selectedInLocation > 0 && selectedInLocation < itemsInLocation.length;

                    return (
                        <AccordionItem value={loc} key={loc} className="border rounded-lg px-4 bg-background">
                            <AccordionTrigger className="hover:no-underline font-headline text-lg">
                                {loc} ({itemsInLocation.length})
                            </AccordionTrigger>
                            <AccordionContent>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead className="w-10 p-2">
                                                 <Checkbox
                                                    checked={allInLocationSelected ? true : someInLocationSelected ? 'indeterminate' : false}
                                                    onCheckedChange={(checked) => handleSelectAll(loc, !!checked)}
                                                    aria-label={`Select all items in ${loc}`}
                                                    disabled={itemsInLocation.length === 0}
                                                />
                                            </TableHead>
                                            <TableHead>Name</TableHead>
                                            <TableHead className="text-center">Quantity</TableHead>
                                            <TableHead>Expires</TableHead>
                                            <TableHead className="text-right">Actions</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {itemsInLocation.length > 0 ? (
                                            itemsInLocation.map(item => (
                                                <TableRow key={item.id} data-state={selectedItems.includes(item.id) && "selected"}>
                                                    <TableCell className="p-2">
                                                        <Checkbox
                                                            checked={selectedItems.includes(item.id)}
                                                            onCheckedChange={(checked) => handleItemSelect(item.id, !!checked)}
                                                            aria-label={`Select ${item.name}`}
                                                        />
                                                    </TableCell>
                                                    <TableCell className="font-medium p-2">{item.name}</TableCell>
                                                    <TableCell className="text-center p-2">{item.quantity} {item.unit}</TableCell>
                                                    <TableCell className="p-2">
                                                        {item.expiryDate ? format(parseISO(item.expiryDate), 'PPP') : 'N/A'}
                                                    </TableCell>
                                                    <TableCell className="text-right p-2">
                                                        <Button variant="ghost" size="icon" onClick={() => openEditDialog(item)}>
                                                            <Edit className="h-4 w-4" />
                                                        </Button>
                                                        <Button variant="ghost" size="icon" onClick={() => setItemToDelete(item)}>
                                                            <Trash2 className="h-4 w-4" />
                                                        </Button>
                                                    </TableCell>
                                                </TableRow>
                                            ))
                                        ) : (
                                            <TableRow>
                                                <TableCell colSpan={5} className="text-center text-muted-foreground h-24">No items in {loc}.</TableCell>
                                            </TableRow>
                                        )}
                                    </TableBody>
                                </Table>
                            </AccordionContent>
                        </AccordionItem>
                    );
                })}
            </Accordion>
        </CardContent>
      </Card>
    </>
  );
}
