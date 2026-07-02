
"use client";

import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { format } from 'date-fns';
import type { MedicationLog } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { PlusCircle, Trash2 } from 'lucide-react';
import { Skeleton } from './ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import { collection, getDocs, deleteDoc, doc, orderBy, query, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';

const logSchema = z.object({
  medication: z.string().min(2, 'Medication name is required.'),
  dosage: z.string().min(1, 'Dosage is required.'),
  notes: z.string().optional(),
});

interface MedicationLogProps {
    petId: string;
}

export function MedicationLogClient({ petId }: MedicationLogProps) {
  const { currentUser } = useAuth();
  const [logs, setLogs] = useState<MedicationLog[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const getLogsCollectionRef = useCallback(() => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, 'pets', petId, 'medication-logs');
  }, [currentUser, petId]);

  const fetchLogs = useCallback(async () => {
    const logsCollection = getLogsCollectionRef();
    if (!logsCollection) {
      setLogs([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const q = query(logsCollection, orderBy('date', 'desc'));
      const querySnapshot = await getDocs(q);
      const logsData = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MedicationLog));
      setLogs(logsData);
    } catch (error) {
      console.error("Error fetching medication logs:", error);
      toast({ variant: 'destructive', title: 'Error', description: 'Could not fetch medication logs.' });
    } finally {
      setLoading(false);
    }
  }, [getLogsCollectionRef, toast]);

  useEffect(() => {
    if (currentUser) {
      fetchLogs();
    }
  }, [currentUser, fetchLogs]);

  const form = useForm<z.infer<typeof logSchema>>({
    resolver: zodResolver(logSchema),
    defaultValues: { medication: '', dosage: '', notes: '' },
  });

  const onSubmit = async (values: z.infer<typeof logSchema>) => {
    const logsCollection = getLogsCollectionRef();
    if (!logsCollection) return;
    const newLog = {
      date: new Date().toISOString(),
      medication: values.medication,
      dosage: values.dosage,
      notes: values.notes || '',
    };
    try {
      const logId = (logs.length + 1).toString();
      await setDoc(doc(logsCollection, logId), newLog);
      form.reset();
      toast({ title: "Log added", description: "Medication has been logged." });
      await fetchLogs();
    } catch {
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to add log.' });
    }
  };

  const deleteLog = async (logId: string) => {
     const logsCollection = getLogsCollectionRef();
     if (!logsCollection) return;
     try {
        await deleteDoc(doc(logsCollection, logId));
        toast({ title: 'Log removed'});
        await fetchLogs();
     } catch {
        toast({ variant: 'destructive', title: 'Error', description: 'Failed to remove log.' });
     }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-headline">Medication Log</CardTitle>
        <CardDescription>Record medication administration.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 p-4 border rounded-lg">
             <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                 <FormField
                  control={form.control}
                  name="medication"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Medication</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Flea & Tick" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                 <FormField
                  control={form.control}
                  name="dosage"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Dosage</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. 1 tablet" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
             </div>
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes (Optional)</FormLabel>
                  <FormControl>
                    <Textarea placeholder="e.g. Hidden in cheese." rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" size="sm"><PlusCircle className="mr-2"/> Add Log Entry</Button>
          </form>
        </Form>
        
        <div className="space-y-4">
            <h3 className="font-semibold">History</h3>
            {loading && (
                <div className="space-y-2">
                    <Skeleton className="h-16 w-full" />
                    <Skeleton className="h-16 w-full" />
                </div>
            )}
            {!loading && logs.length === 0 && (
                <p className="text-sm text-center text-muted-foreground py-4">No medication logs yet.</p>
            )}
            {!loading && logs.map(log => (
                <div key={log.id} className="flex justify-between items-start text-sm p-3 bg-secondary/50 rounded-md">
                    <div>
                        <p className="font-medium">{format(new Date(log.date), 'PPP p')}</p>
                        <p className="text-foreground"><span className="font-semibold">{log.medication}</span> - {log.dosage}</p>
                        {log.notes && <p className="text-muted-foreground mt-1">{log.notes}</p>}
                    </div>
                    <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" onClick={() => deleteLog(log.id)}>
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </div>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}
