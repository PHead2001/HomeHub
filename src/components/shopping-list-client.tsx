

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { categorizeGroceryItem } from '@/ai/flows/categorize-grocery-item-flow';
import { lookupBarcode } from '@/ai/flows/lookup-barcode-flow';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Beer, Car, Cat, Coffee, Dog, Drama, Dumbbell, Gift, HeartPulse, HelpCircle, Home, PawPrint, Pizza, Plane, PlusCircle, Popcorn, School, Shirt, ShoppingCart, Stethoscope, TreePalm, Trash2, Loader2, Settings, X, ArchiveX, Edit, MoreVertical, ScanBarcode, ArrowLeft, Plus, Minus, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ShoppingListItem, ShoppingListCategory, ShoppingList, PantryItem, ShoppingListType, BarcodeLibraryItem } from '@/lib/types';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from './ui/form';
import { Input } from './ui/input';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from './ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import { collection, doc, getDocs, updateDoc, deleteDoc, getDoc, writeBatch, setDoc, query } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { buttonVariants } from './ui/button';
import { slugify } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { BarcodeScanner } from './barcode-scanner';
import Image from 'next/image';


const listSchema = z.object({
  name: z.string().min(1, 'List name is required.'),
  description: z.string().optional(),
  icon: z.string().min(1, 'Icon is required'),
  type: z.enum(['Grocery', 'Auto', 'Hardware', 'Pets', 'Custom']),
  color: z.string().optional(),
});

const defaultLists: {name: string, icon: string, type: ShoppingListType}[] = [
    { name: 'Groceries', icon: 'ShoppingCart', type: 'Grocery' },
    { name: 'Auto', icon: 'Car', type: 'Auto' },
    { name: 'Hardware', icon: 'Wrench', type: 'Hardware' },
    { name: 'Pet Supplies', icon: 'PawPrint', type: 'Pets' },
];

const presetIcons = [ "ShoppingCart", "Car", "Wrench", "PawPrint", "Home", "Gift", "Beer", "Shirt", "Drama", "Popcorn", "Dumbbell", "Plane", "HeartPulse", "Stethoscope", "School", "Dog", "Cat", "TreePalm", "Coffee", "Pizza" ];
const lucideIconRegistry: Partial<Record<string, LucideIcon>> = {
  Beer,
  Car,
  Cat,
  Coffee,
  Dog,
  Drama,
  Dumbbell,
  Gift,
  HeartPulse,
  HelpCircle,
  Home,
  PawPrint,
  Pizza,
  Plane,
  Popcorn,
  School,
  Shirt,
  ShoppingCart,
  Stethoscope,
  TreePalm,
  Wrench,
};

const getLucideIcon = (name: string, fallback: LucideIcon): LucideIcon => {
  return lucideIconRegistry[name] ?? fallback;
};

function ListDialog({
  isOpen,
  onOpenChange,
  onSave,
  listToEdit,
}: {
  isOpen: boolean,
  onOpenChange: (open: boolean) => void,
  onSave: (data: z.infer<typeof listSchema>, id?: string) => Promise<void>,
  listToEdit: ShoppingList | null,
}) {
  const [showCustomForm, setShowCustomForm] = useState(false);

  const form = useForm<z.infer<typeof listSchema>>({
    resolver: zodResolver(listSchema),
    defaultValues: { name: '', description: '', icon: 'ShoppingCart', type: 'Custom', color: '' },
  });
  
  useEffect(() => {
    if (listToEdit) {
      form.reset({
        name: listToEdit.name,
        description: listToEdit.description || '',
        icon: listToEdit.icon,
        type: listToEdit.type,
        color: listToEdit.color || '',
      });
      setShowCustomForm(true); // Editing always shows the custom form
    } else {
      // Reset form when not editing
      form.reset({ name: '', description: '', icon: 'Home', type: 'Custom', color: '' });
      setShowCustomForm(false);
    }
  }, [listToEdit, isOpen, form]); // Rerun when dialog opens/closes or listToEdit changes


  const handleSave = (data: z.infer<typeof listSchema>, id?: string) => {
    onSave(data, id);
    onOpenChange(false);
  };
  
  const handleDefaultClick = (defaultListData: {name: string, icon: string, type: ShoppingListType}) => {
    handleSave({ ...defaultListData, description: ''});
  }
  
  const { watch, setValue } = form;
  const selectedIconName = watch('icon');
  const selectedColor = watch('color');

  const renderIcon = (name: string) => {
    const Icon = getLucideIcon(name, HelpCircle);
    return <Icon className="h-8 w-8" />;
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-headline">{listToEdit ? 'Edit List' : 'Create New List'}</DialogTitle>
           {!listToEdit && <DialogDescription>Choose a template or create a custom list.</DialogDescription>}
        </DialogHeader>
        
        {!showCustomForm && !listToEdit ? (
          <div className="grid grid-cols-2 gap-4 py-4">
              {defaultLists.map((list) => (
                  <Button key={list.name} variant="outline" className="h-24 flex-col gap-2" onClick={() => handleDefaultClick(list)}>
                     {renderIcon(list.icon)}
                      <span>{list.name}</span>
                  </Button>
              ))}
              <Button variant="outline" className="h-24 flex-col gap-2" onClick={() => setShowCustomForm(true)}>
                  <PlusCircle className="h-8 w-8"/>
                  <span>Custom</span>
              </Button>
          </div>
        ) : (
            <Form {...form}>
              <form onSubmit={form.handleSubmit((data) => handleSave(data, listToEdit?.id))} className="space-y-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem>
                    <FormLabel>List Name</FormLabel>
                    <FormControl><Input placeholder="e.g. Groceries, Home Depot" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <div className="flex gap-4">
                    <FormField
                    control={form.control}
                    name="icon"
                    render={() => (
                        <FormItem className="flex-1">
                        <FormLabel>Icon</FormLabel>
                        <div className="grid grid-cols-5 gap-2 border p-2 rounded-lg">
                            {presetIcons.slice(0,10).map(iconName => { // First row
                                const Icon = getLucideIcon(iconName, HelpCircle);
                                return (
                                    <Button key={iconName} type="button" variant="outline" className={cn("h-12", selectedIconName === iconName && "ring-2 ring-primary")} onClick={() => setValue('icon', iconName, { shouldValidate: true })}>
                                        <Icon />
                                    </Button>
                                )
                            })}
                        </div>
                        <div className="grid grid-cols-5 gap-2 border p-2 rounded-lg">
                            {presetIcons.slice(10,20).map(iconName => { // Second row
                                const Icon = getLucideIcon(iconName, HelpCircle);
                                return (
                                    <Button key={iconName} type="button" variant="outline" className={cn("h-12", selectedIconName === iconName && "ring-2 ring-primary")} onClick={() => setValue('icon', iconName, { shouldValidate: true })}>
                                        <Icon />
                                    </Button>
                                )
                            })}
                        </div>
                        <FormMessage>{form.formState.errors.icon?.message}</FormMessage>
                        </FormItem>
                    )}
                    />
                    <FormField
                        control={form.control}
                        name="color"
                        render={({ field }) => (
                            <FormItem className="flex flex-col items-center gap-2">
                                <FormLabel>Color</FormLabel>
                                 <FormControl>
                                    <div className="relative h-12 w-12 rounded-md border-2 border-input">
                                        <Input 
                                            type="color" 
                                            {...field}
                                            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                                        />
                                        <div className="h-full w-full rounded-md" style={{ backgroundColor: selectedColor || 'transparent' }} />
                                    </div>
                                 </FormControl>
                            </FormItem>
                        )}
                    />
                </div>
                
                <DialogFooter>
                  <Button type="submit">Save List</Button>
                </DialogFooter>
              </form>
            </Form>
        )}

      </DialogContent>
    </Dialog>
  )
}

function ListCard({ list, onSelect, onEdit, onDelete }: { list: ShoppingList, onSelect: () => void, onEdit: () => void, onDelete: () => void }) {
  const Icon = getLucideIcon(list.icon, HelpCircle);
  const cardColor = list.color;
  return (
    <Card className="flex flex-col justify-between hover:shadow-lg transition-shadow">
        <CardHeader>
            <div className="flex justify-between items-start">
                <div className="flex items-center gap-3">
                    <Icon className="h-8 w-8" style={{ color: cardColor }}/>
                    <div>
                        <CardTitle className="font-headline">{list.name}</CardTitle>
                        <CardDescription>{list.description}</CardDescription>
                    </div>
                </div>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8"><MoreVertical /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                        <DropdownMenuItem onClick={onEdit}><Edit className="mr-2" /> Edit</DropdownMenuItem>
                        <DropdownMenuItem onClick={onDelete} className="text-destructive"><Trash2 className="mr-2"/> Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </CardHeader>
        <CardContent>
             <Button className="w-full" onClick={onSelect} style={{ backgroundColor: cardColor }}>Open List</Button>
        </CardContent>
    </Card>
  )
}


const itemSchema = z.object({
  name: z.string().min(1, 'Item name is required.'),
  quantity: z.coerce.number().min(1, 'Quantity must be at least 1.'),
});

function ManageCategoriesDialog({ categories, setCategories, householdId, listId, onUpdate }: { categories: ShoppingListCategory[], setCategories: React.Dispatch<React.SetStateAction<ShoppingListCategory[]>>, householdId: string, listId: string, onUpdate: () => void }) {
  const [newCategory, setNewCategory] = useState('');
  const [isCategoryDialogOpen, setIsCategoryDialogOpen] = useState(false);
  
  const categoriesDocRef = doc(db, 'households', householdId, 'shopping-lists', listId, 'config', 'categories');

  const addCategory = async () => {
    if (newCategory && !categories.find(c => c.toLowerCase() === newCategory.toLowerCase())) {
      const updatedCategories = [...categories, newCategory].sort((a,b) => a.localeCompare(b));
      await setDoc(categoriesDocRef, { list: updatedCategories });
      setCategories(updatedCategories);
      setNewCategory('');
      onUpdate();
    }
  };

  const removeCategory = async (categoryToRemove: string) => {
    if (categoryToRemove === 'Other') return;
    const updatedCategories = categories.filter(c => c !== categoryToRemove);
    await setDoc(categoriesDocRef, { list: updatedCategories });
    setCategories(updatedCategories);
    onUpdate();
  };

  return (
    <Dialog open={isCategoryDialogOpen} onOpenChange={setIsCategoryDialogOpen}>
      <DialogTrigger asChild>
        <Button variant="outline"><Settings className="mr-2 h-4 w-4" /> Manage Categories</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-headline">Manage Categories</DialogTitle>
          <DialogDescription>Add or remove shopping list categories. &apos;Other&apos; cannot be removed.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="flex gap-2">
            <Input 
              value={newCategory} 
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="New category name"
              onKeyDown={(e) => e.key === 'Enter' && addCategory()}
            />
            <Button onClick={addCategory}>Add</Button>
          </div>
          <div className="space-y-2">
            <h4 className="font-medium">Existing Categories</h4>
            <div className="flex flex-wrap gap-2">
              {categories.map(category => (
                <div key={category} className="flex items-center gap-1 rounded-full bg-secondary px-3 py-1 text-sm text-secondary-foreground">
                  {category}
                  {category !== 'Other' && (
                    <button onClick={() => removeCategory(category)} className="ml-1 rounded-full hover:bg-muted p-0.5">
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setIsCategoryDialogOpen(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ShoppingListClient({ onAddItemToPantry, selectedList, onSelectList }: { onAddItemToPantry: (item: PantryItem, currentList: ShoppingList) => void, selectedList: ShoppingList | null, onSelectList: (list: ShoppingList | null) => void }) {
  const { currentUser } = useAuth();
  const { toast } = useToast();
  
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [listItems, setListItems] = useState<ShoppingListItem[]>([]);
  const [categories, setCategories] = useState<ShoppingListCategory[]>(['Produce', 'Dairy', 'Meat', 'Bakery', 'Pantry', 'Frozen', 'Snacks', 'Drinks', 'Household', 'Other']);
  
  const [loading, setLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  
  const [isAddItemDialogOpen, setIsAddItemDialogOpen] = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isListDialogOpen, setIsListDialogOpen] = useState(false);
  const [listToEdit, setListToEdit] = useState<ShoppingList | null>(null);
  const [listToDelete, setListToDelete] = useState<ShoppingList | null>(null);
  const [isClearAlertOpen, setIsClearAlertOpen] = useState(false);
  const [isArchiveAlertOpen, setIsArchiveAlertOpen] = useState(false);
  
  // --- Data Fetching ---

  const getListsCollectionRef = useCallback(() => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, 'shopping-lists');
  }, [currentUser]);

  const fetchLists = useCallback(async () => {
    const listsCollection = getListsCollectionRef();
    if (!listsCollection) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const snapshot = await getDocs(query(listsCollection));
      const listsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ShoppingList));
      setLists(listsData);
    } catch {
      toast({ variant: 'destructive', title: 'Error', description: 'Could not fetch shopping lists.' });
    } finally {
      setLoading(false);
    }
  }, [getListsCollectionRef, toast]);
  
  const fetchItemsAndCategories = useCallback(async (listId: string) => {
    if (!currentUser?.householdId) return;
    setLoadingItems(true);
    try {
      const itemsCollection = collection(db, 'households', currentUser.householdId, 'shopping-lists', listId, 'items');
      const categoriesDoc = doc(db, 'households', currentUser.householdId, 'shopping-lists', listId, 'config', 'categories');
      
      const [itemsSnapshot, categoriesSnapshot] = await Promise.all([
        getDocs(query(itemsCollection)),
        getDoc(categoriesDoc)
      ]);

      const itemsData = itemsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ShoppingListItem));
      setListItems(itemsData);

      if (categoriesSnapshot.exists()) {
        setCategories(categoriesSnapshot.data().list);
      } else {
        // Reset to default if no specific categories are set for this list
        setCategories(['Produce', 'Dairy', 'Meat', 'Bakery', 'Pantry', 'Frozen', 'Snacks', 'Drinks', 'Household', 'Other']);
      }
    } catch {
      toast({ variant: 'destructive', title: 'Error', description: 'Could not fetch list items.' });
    } finally {
      setLoadingItems(false);
    }
  }, [currentUser, toast]);

  useEffect(() => {
    if (currentUser?.householdId) {
      fetchLists();
    }
  }, [currentUser, fetchLists]);

  useEffect(() => {
    if (selectedList) {
      fetchItemsAndCategories(selectedList.id);
    } else {
      setListItems([]);
    }
  }, [selectedList, fetchItemsAndCategories]);

  // --- List CRUD ---

  const handleSaveList = async (data: z.infer<typeof listSchema>, id?: string) => {
    const listsCollection = getListsCollectionRef();
    if (!listsCollection) return;
    const listId = id || slugify(data.name);
    try {
      await setDoc(doc(listsCollection, listId), data, { merge: true });
      toast({ title: id ? 'List Updated!' : 'List Created!' });
      fetchLists();
    } catch {
       toast({ variant: 'destructive', title: 'Error', description: 'Could not save list.' });
    }
  }

  const handleDeleteList = async () => {
    const listIdToDelete = listToDelete?.id;
    if (!listIdToDelete) return;

    const listsCollection = getListsCollectionRef();
    if (!listsCollection) return;

    try {
        // This does not delete subcollections. For a production app, a Cloud Function would be needed for that.
        await deleteDoc(doc(listsCollection, listIdToDelete));
        toast({ title: 'List Deleted' });
        
        // Reset state
        setListToDelete(null);
        if (selectedList?.id === listIdToDelete) {
            onSelectList(null);
        }
        
        // Refetch the list of lists
        await fetchLists();

    } catch {
        toast({ variant: 'destructive', title: 'Error', description: 'Could not delete list.' });
    }
  };


  // --- List Item CRUD ---

  const form = useForm<z.infer<typeof itemSchema>>({
    resolver: zodResolver(itemSchema),
    defaultValues: { name: '', quantity: 1 },
  });
  const { watch, setValue, getValues } = form;
  const currentQuantity = watch('quantity');

  const onAddItemSubmit = async (values: z.infer<typeof itemSchema>, libraryItem?: BarcodeLibraryItem | null, barcode?: string) => {
    if (!currentUser?.householdId || !selectedList) return;
    try {
        toast({ title: "Categorizing item..." });
        const { category } = await categorizeGroceryItem({ itemName: values.name, categories });
        const newItem: Omit<ShoppingListItem, 'id' | 'status'> = {
            name: values.name,
            quantity: values.quantity,
            category: category,
            createdAt: new Date(),
            imageUrl: libraryItem?.imageUrl,
            barcode: barcode,
        };
        const itemId = slugify(values.name);
        await setDoc(doc(db, 'households', currentUser.householdId, 'shopping-lists', selectedList.id, 'items', itemId), { ...newItem, status: 'needed' });
        toast({ title: "Item Added", description: `${values.name} was added to the ${category} category.` });
        form.reset({ name: '', quantity: 1 });
        setIsAddItemDialogOpen(false);
        await fetchItemsAndCategories(selectedList.id);
    } catch {
      toast({ variant: 'destructive', title: 'Error', description: 'Could not categorize item. Please try again.' });
    }
  };

  const handleBarcodeScan = async (barcode: string) => {
    if (!currentUser?.householdId) return;
    setIsScannerOpen(false);
    toast({ title: "Barcode Scanned!", description: "Looking up product..." });
    try {
        const { productName, libraryItem } = await lookupBarcode({ barcode, householdId: currentUser.householdId });
        
        const finalName = libraryItem?.name || productName;

        if (finalName) {
            await onAddItemSubmit({ name: finalName, quantity: 1 }, libraryItem, barcode);
        } else {
            toast({ variant: 'destructive', title: 'Product Not Found', description: 'Could not find a product for that barcode. You can add it to your library manually.' });
        }
    } catch (error) {
        console.error(error);
        toast({ variant: 'destructive', title: 'Lookup Failed', description: 'An error occurred while looking up the barcode.' });
    }
  };

  const toggleItemStatus = async (item: ShoppingListItem) => {
      if (!currentUser?.householdId || !selectedList) return;
      
      const isCheckingOff = item.status === 'needed';
      const newStatus = isCheckingOff ? 'purchased' : 'needed';

      const itemRef = doc(db, 'households', currentUser.householdId, 'shopping-lists', selectedList.id, 'items', item.id);
      try {
        await updateDoc(itemRef, { status: newStatus });
        
        if (isCheckingOff && selectedList.type === 'Grocery') {
           onAddItemToPantry({
            id: '', // Will be generated by pantry logic
            name: item.name,
            quantity: item.quantity,
            unit: 'items',
            location: 'Pantry'
           }, selectedList);
        }
        await fetchItemsAndCategories(selectedList.id);

      } catch {
          toast({ variant: 'destructive', title: 'Error', description: 'Could not update item status.' });
      }
  };

  const deleteItem = async (itemId: string) => {
    if (!currentUser?.householdId || !selectedList) return;
    await deleteDoc(doc(db, 'households', currentUser.householdId, 'shopping-lists', selectedList.id, 'items', itemId));
    await fetchItemsAndCategories(selectedList.id);
  };

  const clearPurchasedItems = async () => {
    if (!currentUser?.householdId || !selectedList) return;
    const householdId = currentUser.householdId;
    const purchased = listItems.filter(i => i.status === 'purchased');
    if (purchased.length === 0) {
      toast({ title: "Nothing to clear!" });
      setIsClearAlertOpen(false);
      return;
    }
    const batch = writeBatch(db);
    purchased.forEach(item => {
      batch.delete(doc(db, 'households', householdId, 'shopping-lists', selectedList.id, 'items', item.id));
    });
    try {
      await batch.commit();
      toast({ title: "Purchased items cleared." });
      
      const remainingItems = listItems.filter(i => i.status === 'needed');
      setIsClearAlertOpen(false);

      if (remainingItems.length === 0) {
        setListToDelete(selectedList);
        setIsArchiveAlertOpen(true);
      } else {
        await fetchItemsAndCategories(selectedList.id);
      }
    } catch {
      toast({ variant: 'destructive', title: 'Error', description: 'Could not clear purchased items.' });
    }
  };

  const archiveList = async () => {
      await handleDeleteList();
      setIsArchiveAlertOpen(false);
  }

  const adjustQuantity = (amount: number) => {
    const currentVal = getValues('quantity');
    const newVal = Math.max(1, currentVal + amount);
    setValue('quantity', newVal, { shouldValidate: true });
  }
  
  // --- Render Logic ---

  if (loading) {
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-48 w-full" />
        </div>
    );
  }

  // View for showing the selected list's items
  if (selectedList) {
    const neededItems = listItems.filter(i => i.status === 'needed');
    const purchasedItems = listItems.filter(i => i.status === 'purchased');

    return (
        <>
            <AlertDialog open={isClearAlertOpen} onOpenChange={setIsClearAlertOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                    <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                    <AlertDialogDescription>
                        This will permanently delete all {purchasedItems.length} purchased items. This action cannot be undone.
                    </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={clearPurchasedItems} className={buttonVariants({ variant: "destructive" })}>
                        Clear Purchased
                    </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
             <AlertDialog open={isArchiveAlertOpen} onOpenChange={setIsArchiveAlertOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                    <AlertDialogTitle>Delete Empty List?</AlertDialogTitle>
                    <AlertDialogDescription>
                       This shopping list is now empty. Would you like to delete it?
                    </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                    <AlertDialogCancel onClick={() => setListToDelete(null)}>No, keep it</AlertDialogCancel>
                    <AlertDialogAction onClick={archiveList} className={buttonVariants({ variant: "destructive"})}>
                        Yes, delete it
                    </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                    <div>
                        <Button variant="ghost" onClick={() => onSelectList(null)} className="mb-4 pl-1">
                           <ArrowLeft className="mr-2"/> Back to all lists
                        </Button>
                        <CardTitle className="font-headline" style={{color: selectedList.color}}>{selectedList.name}</CardTitle>
                    </div>
                    <div className="flex items-center gap-2">
                        {currentUser?.householdId && <ManageCategoriesDialog categories={categories} setCategories={setCategories} householdId={currentUser.householdId} listId={selectedList.id} onUpdate={() => fetchItemsAndCategories(selectedList.id)}/>}
                        <Dialog open={isAddItemDialogOpen} onOpenChange={setIsAddItemDialogOpen}>
                        <DialogTrigger asChild>
                            <Button><PlusCircle className="mr-2" /> Add Item</Button>
                        </DialogTrigger>
                        <DialogContent>
                            <DialogHeader>
                                <DialogTitle className="font-headline">Add Item to List</DialogTitle>
                                <DialogDescription>Enter an item name or scan a barcode.</DialogDescription>
                            </DialogHeader>
                            <Form {...form}>
                                <form onSubmit={form.handleSubmit((v) => onAddItemSubmit(v))} className="space-y-4 py-4">
                                <FormField
                                    control={form.control}
                                    name="name"
                                    render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Item Name</FormLabel>
                                        <FormControl>
                                        <Input placeholder="e.g. Olive Oil" {...field} />
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
                                            <Button type="button" variant="outline" size="icon" className="h-10 w-10" onClick={() => adjustQuantity(-1)} disabled={currentQuantity <= 1}>
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
                                <DialogFooter className="justify-between sm:justify-between">
                                      <Dialog open={isScannerOpen} onOpenChange={setIsScannerOpen}>
                                        <DialogTrigger asChild>
                                           <Button type="button" variant="outline"><ScanBarcode className="mr-2"/> Scan Barcode</Button>
                                        </DialogTrigger>
                                        <DialogContent>
                                            <DialogHeader>
                                                <DialogTitle>Scan Barcode</DialogTitle>
                                            </DialogHeader>
                                            <BarcodeScanner onScan={handleBarcodeScan} />
                                        </DialogContent>
                                      </Dialog>
                                    <Button type="submit" disabled={form.formState.isSubmitting}>
                                        {form.formState.isSubmitting ? ( <Loader2 className="mr-2 h-4 w-4 animate-spin" /> ) : ( "Add to List" )}
                                    </Button>
                                </DialogFooter>
                                </form>
                            </Form>
                        </DialogContent>
                        </Dialog>
                    </div>
                </CardHeader>
                <CardContent>
                    {loadingItems ? <Loader2 className="animate-spin mx-auto"/> : (
                         <Accordion type="multiple" defaultValue={['needed']} className="w-full">
                            <AccordionItem value="needed">
                            <AccordionTrigger className="font-headline text-lg">Needed ({neededItems.length})</AccordionTrigger>
                            <AccordionContent>
                                <div className="space-y-4">
                                {categories.map(category => {
                                    const itemsInCategory = neededItems.filter(item => item.category === category);
                                    if (itemsInCategory.length === 0) return null;
                                    return (
                                        <div key={category}>
                                            <h4 className="font-semibold text-md mb-2" style={{color: selectedList.color}}>{category}</h4>
                                            <div className="space-y-2">
                                            {itemsInCategory.sort((a,b) => a.name.localeCompare(b.name)).map((item) => (
                                                <div key={item.id} className="flex items-center justify-between p-2 rounded-md hover:bg-secondary">
                                                <div className="flex items-center gap-3">
                                                    <Checkbox id={`item-needed-${item.id}`} onCheckedChange={() => toggleItemStatus(item)} />
                                                    {item.imageUrl && (
                                                        <Image src={item.imageUrl} alt={item.name} width={40} height={40} className="rounded-md object-cover h-10 w-10"/>
                                                    )}
                                                    <label htmlFor={`item-needed-${item.id}`} className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">{item.name} <span className="text-muted-foreground">(x{item.quantity})</span></label>
                                                </div>
                                                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => deleteItem(item.id)}>
                                                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                                                </Button>
                                                </div>
                                            ))}
                                            </div>
                                        </div>
                                    );
                                })}
                                {neededItems.length === 0 && <p className="text-center text-muted-foreground py-4">Nothing to buy!</p>}
                                </div>
                            </AccordionContent>
                            </AccordionItem>
                            <AccordionItem value="purchased">
                            <div className="flex items-center">
                                <AccordionTrigger className="font-headline text-lg flex-1">Purchased ({purchasedItems.length})</AccordionTrigger>
                                {purchasedItems.length > 0 && (
                                    <Button variant="ghost" size="sm" onClick={() => setIsClearAlertOpen(true)} className="text-muted-foreground hover:text-destructive">
                                        <ArchiveX className="mr-2 h-4 w-4" /> Clear
                                    </Button>
                                )}
                            </div>
                            <AccordionContent>
                                <div className="space-y-2">
                                {purchasedItems.sort((a,b) => a.name.localeCompare(b.name)).map((item) => (
                                    <div key={item.id} className="flex items-center justify-between p-2 rounded-md hover:bg-secondary">
                                        <div className="flex items-center gap-3">
                                        <Checkbox id={`item-purchased-${item.id}`} checked={true} onCheckedChange={() => toggleItemStatus(item)} />
                                        {item.imageUrl && (
                                            <Image src={item.imageUrl} alt={item.name} width={40} height={40} className="rounded-md object-cover h-10 w-10 opacity-50"/>
                                        )}
                                        <label htmlFor={`item-purchased-${item.id}`} className="text-sm font-medium leading-none text-muted-foreground line-through">{item.name} <span className="text-muted-foreground">(x{item.quantity})</span></label>
                                        </div>
                                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => deleteItem(item.id)}>
                                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                                        </Button>
                                    </div>
                                ))}
                                {purchasedItems.length === 0 && <p className="text-center text-muted-foreground py-4">No items purchased yet.</p>}
                                </div>
                            </AccordionContent>
                            </AccordionItem>
                        </Accordion>
                    )}
                </CardContent>
            </Card>
        </>
    )
  }

  // Main view for showing all lists
  return (
    <>
      <ListDialog 
        isOpen={isListDialogOpen}
        onOpenChange={setIsListDialogOpen}
        onSave={handleSaveList}
        listToEdit={listToEdit}
      />
       <AlertDialog open={!!listToDelete} onOpenChange={(open) => !open && setListToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {listToDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this list and all its items. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={handleDeleteList}>
              Delete List
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex justify-end mb-4">
        <Button onClick={() => { setListToEdit(null); setIsListDialogOpen(true); }}>
            <PlusCircle className="mr-2"/> Create New List
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {lists.map(list => (
            <ListCard 
                key={list.id} 
                list={list} 
                onSelect={() => onSelectList(list)}
                onEdit={() => { setListToEdit(list); setIsListDialogOpen(true); }}
                onDelete={() => setListToDelete(list)}
            />
        ))}
      </div>
       {lists.length === 0 && !loading && (
         <div className="text-center py-16 border-2 border-dashed rounded-lg col-span-full">
          <h2 className="text-xl font-semibold">No Shopping Lists Yet</h2>
          <p className="text-muted-foreground mt-2">Click &quot;Create New List&quot; to get started!</p>
        </div>
      )}
    </>
  );
}
