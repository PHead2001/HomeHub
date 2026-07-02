
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAuth } from '@/hooks/use-auth';
import { db } from '@/lib/firebase';
import { collection, doc, getDocs, setDoc, deleteDoc, query, orderBy } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { v4 as uuidv4 } from 'uuid';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { PlusCircle, Edit, Trash2, ScanBarcode, Loader2 } from 'lucide-react';
import type { BarcodeLibraryItem } from '@/lib/types';
import { Skeleton } from './ui/skeleton';
import { BarcodeScanner } from './barcode-scanner';
import { ImageUpload } from './image-upload';
import Image from 'next/image';
import { format } from 'date-fns';

const libraryItemSchema = z.object({
  id: z.string().min(1, 'Barcode is required.'),
  name: z.string().min(2, 'Product name is required.'),
});

function LibraryItemDialog({
  isOpen,
  onOpenChange,
  onSave,
  itemToEdit,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: z.infer<typeof libraryItemSchema>, photoFile: File | null) => Promise<boolean>;
  itemToEdit: BarcodeLibraryItem | null;
}) {
  const { toast } = useToast();
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const form = useForm<z.infer<typeof libraryItemSchema>>({
    resolver: zodResolver(libraryItemSchema),
    defaultValues: { id: '', name: '' },
  });
  const { reset, setValue } = form;

  useEffect(() => {
    if (itemToEdit) {
      reset({ id: itemToEdit.id, name: itemToEdit.name });
    } else {
      reset({ id: '', name: '' });
    }
    setPhotoFile(null);
  }, [itemToEdit, isOpen, reset]);

  const handleBarcodeScan = (barcode: string) => {
    setValue('id', barcode, { shouldValidate: true });
    setIsScannerOpen(false);
    toast({ title: 'Barcode Scanned', description: `Code: ${barcode}` });
  };

  const handleSubmit = async (data: z.infer<typeof libraryItemSchema>) => {
    // Manually check for photo file on new items
    if (!itemToEdit && !photoFile) {
        toast({ variant: 'destructive', title: 'Missing Image', description: 'Please upload an image for the new item.' });
        return;
    }

    setIsSaving(true);
    const success = await onSave(data, photoFile);
    if (success) {
      onOpenChange(false);
    }
    setIsSaving(false);
  };

  return (
    <>
      <Dialog open={isScannerOpen} onOpenChange={setIsScannerOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Scan Barcode</DialogTitle></DialogHeader>
          <BarcodeScanner onScan={handleBarcodeScan} />
        </DialogContent>
      </Dialog>
      <Dialog open={isOpen} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-headline">{itemToEdit ? 'Edit Library Item' : 'Add New Library Item'}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4 py-4">
              <FormField
                control={form.control}
                name="id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Barcode (UPC)</FormLabel>
                    <div className="flex gap-2">
                      <FormControl>
                        <Input placeholder="Scan or type barcode" {...field} disabled={!!itemToEdit} />
                      </FormControl>
                      {!itemToEdit && (
                        <Button type="button" variant="outline" size="icon" onClick={() => setIsScannerOpen(true)}>
                          <ScanBarcode />
                        </Button>
                      )}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Product Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Heinz Tomato Ketchup" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormItem>
                <FormLabel>Product Image</FormLabel>
                <FormControl>
                  <ImageUpload onFileChange={setPhotoFile} existingImageUrl={itemToEdit?.imageUrl} />
                </FormControl>
                 {!photoFile && !itemToEdit?.imageUrl && <FormMessage>An image is required.</FormMessage>}
              </FormItem>
              <DialogFooter>
                <Button type="submit" disabled={isSaving}>
                    {isSaving && <Loader2 className="mr-2 animate-spin" />}
                    Save Item
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function BarcodeLibraryClient() {
  const { currentUser } = useAuth();
  const { toast } = useToast();
  const [items, setItems] = useState<BarcodeLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [itemToEdit, setItemToEdit] = useState<BarcodeLibraryItem | null>(null);

  const getLibraryCollectionRef = useCallback(() => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, 'barcode-library');
  }, [currentUser]);

  const fetchItems = useCallback(async () => {
    const collectionRef = getLibraryCollectionRef();
    if (!collectionRef) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const q = query(collectionRef, orderBy('createdAt', 'desc'));
      const snapshot = await getDocs(q);
      const itemsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as BarcodeLibraryItem));
      setItems(itemsData);
    } catch (error) {
      console.error('Error fetching barcode library:', error);
      toast({ variant: 'destructive', title: 'Error', description: 'Could not fetch library items.' });
    } finally {
      setLoading(false);
    }
  }, [getLibraryCollectionRef, toast]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const uploadPhoto = async (photoFile: File): Promise<string> => {
    if (!currentUser?.householdId) throw new Error("User not in a household");
    const storage = getStorage();
    const fileExtension = photoFile.name.split('.').pop();
    const fileName = `${uuidv4()}.${fileExtension}`;
    const storageRef = ref(storage, `households/${currentUser.householdId}/barcode-library/${fileName}`);
    await uploadBytes(storageRef, photoFile);
    return await getDownloadURL(storageRef);
  };


  const handleSave = async (data: z.infer<typeof libraryItemSchema>, photoFile: File | null): Promise<boolean> => {
    const collectionRef = getLibraryCollectionRef();
    if (!collectionRef) {
        toast({ variant: 'destructive', title: 'Error', description: 'Cannot find database collection.' });
        return false;
    }

    try {
        let finalImageUrl = itemToEdit?.imageUrl;

        if (photoFile) {
            finalImageUrl = await uploadPhoto(photoFile);
        }

        if (!finalImageUrl) {
            toast({ variant: 'destructive', title: 'Image Required', description: 'A product image is mandatory to save an item.' });
            return false;
        }

        const itemData: Omit<BarcodeLibraryItem, 'id'> = {
            name: data.name,
            imageUrl: finalImageUrl,
            createdAt: itemToEdit?.createdAt || new Date().toISOString(),
        };

        await setDoc(doc(collectionRef, data.id), itemData);
        toast({ title: 'Item Saved', description: `${data.name} has been saved to your library.` });
        await fetchItems();
        return true;
    } catch (error) {
        console.error('Error saving library item:', error);
        toast({ variant: 'destructive', title: 'Save Failed', description: 'An unexpected error occurred while saving.' });
        return false;
    }
  };

  const handleDelete = async (item: BarcodeLibraryItem) => {
    const collectionRef = getLibraryCollectionRef();
    if (!collectionRef) return;
    try {
        await deleteObject(ref(getStorage(), item.imageUrl)).catch((error) => {
          console.warn('Could not delete barcode image from storage:', error);
        });
        await deleteDoc(doc(collectionRef, item.id));
        toast({title: "Item Deleted"});
        fetchItems();
    } catch {
        toast({ variant: 'destructive', title: 'Delete Failed' });
    }
  }

  const openDialogToAdd = () => {
    setItemToEdit(null);
    setIsDialogOpen(true);
  };

  const openDialogToEdit = (item: BarcodeLibraryItem) => {
    setItemToEdit(item);
    setIsDialogOpen(true);
  };


  return (
    <>
      <LibraryItemDialog
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        itemToEdit={itemToEdit}
        onSave={handleSave}
      />
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="font-headline">Your Library</CardTitle>
            <CardDescription>You have {items.length} items saved.</CardDescription>
          </div>
          <Button onClick={openDialogToAdd}><PlusCircle /> Add Item</Button>
        </CardHeader>
        <CardContent>
          {loading ? (
             <Skeleton className="h-48 w-full" />
          ) : (
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Image</TableHead>
                        <TableHead>Product Name</TableHead>
                        <TableHead>Barcode</TableHead>
                        <TableHead>Date Added</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {items.length > 0 ? items.map(item => (
                        <TableRow key={item.id}>
                            <TableCell>
                                <Image src={item.imageUrl} alt={item.name} width={40} height={40} className="rounded-md object-cover h-10 w-10" />
                            </TableCell>
                            <TableCell className="font-medium">{item.name}</TableCell>
                            <TableCell className="font-mono text-xs">{item.id}</TableCell>
                            <TableCell>{format(new Date(item.createdAt), 'PPP')}</TableCell>
                            <TableCell className="text-right">
                                <Button variant="ghost" size="icon" onClick={() => openDialogToEdit(item)}><Edit/></Button>
                                <Button variant="ghost" size="icon" onClick={() => handleDelete(item)}><Trash2/></Button>
                            </TableCell>
                        </TableRow>
                    )) : (
                        <TableRow>
                            <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">
                                Your library is empty. Add an item to get started.
                            </TableCell>
                        </TableRow>
                    )}
                </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
