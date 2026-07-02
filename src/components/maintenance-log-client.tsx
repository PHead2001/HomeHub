
"use client";

import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { format } from 'date-fns';
import { summarizeMaintenanceLog } from '@/ai/flows/summarize-maintenance-log';
import type { MaintenanceLog } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Sparkles, PlusCircle } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import { Skeleton } from './ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import { collection, getDocs, doc, orderBy, query, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { slugify } from '@/lib/utils';

const logSchema = z.object({
  item: z.string().min(1, 'Item name is required.'),
  notes: z.string().min(10, 'Please provide some details in the notes.'),
});

export function MaintenanceLogClient() {
  const { currentUser } = useAuth();
  const [logs, setLogs] = useState<MaintenanceLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [loadingStates, setLoadingStates] = useState<Record<string, boolean>>({});
  const { toast } = useToast();

  const getLogsCollectionRef = useCallback(() => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, 'maintenance');
  }, [currentUser]);


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
          const logsData = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MaintenanceLog));
          setLogs(logsData);
      } catch (error) {
          console.error("Error fetching logs:", error);
          toast({ variant: 'destructive', title: 'Error', description: 'Could not fetch maintenance logs.' });
      } finally {
          setLoading(false);
      }
  }, [getLogsCollectionRef, toast]);

  useEffect(() => {
    if (currentUser?.householdId) {
      fetchLogs();
    } else {
      setLoading(false);
    }
  }, [currentUser, fetchLogs]);

  const form = useForm<z.infer<typeof logSchema>>({
    resolver: zodResolver(logSchema),
    defaultValues: { item: '', notes: '' },
  });

  const onSubmit = async (values: z.infer<typeof logSchema>) => {
    const logsCollection = getLogsCollectionRef();
    if (!logsCollection) return;
    const newLog = {
      item: values.item,
      notes: values.notes,
      date: new Date().toISOString(),
    };
    try {
        const logId = slugify(values.item);
        await setDoc(doc(logsCollection, logId), newLog);
        form.reset();
        toast({ title: "Log added", description: `${values.item} has been logged.` });
        await fetchLogs();
    } catch {
        toast({ variant: 'destructive', title: 'Error', description: 'Failed to add log.' });
    }
  };

  const handleSummarize = async (log: MaintenanceLog) => {
    setLoadingStates(prev => ({...prev, [log.id]: true}));
    try {
      const result = await summarizeMaintenanceLog({ log: log.notes });
      setSummaries(prev => ({...prev, [log.id]: result.summary}));
    } catch (error) {
      console.error(error);
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to generate summary.' });
    } finally {
        setLoadingStates(prev => ({...prev, [log.id]: false}));
    }
  };

  if (loading) {
    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="md:col-span-1">
                <Card>
                    <CardHeader>
                        <Skeleton className="h-8 w-3/4" />
                        <Skeleton className="h-4 w-1/2" />
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <Skeleton className="h-10" />
                        <Skeleton className="h-20" />
                        <Skeleton className="h-10" />
                    </CardContent>
                </Card>
            </div>
            <div className="md:col-span-2">
                <Card>
                    <CardHeader>
                        <Skeleton className="h-8 w-1/3" />
                        <Skeleton className="h-4 w-1/2" />
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <Skeleton className="h-12 w-full" />
                        <Skeleton className="h-12 w-full" />
                    </CardContent>
                </Card>
            </div>
        </div>
    )
  }

  if (!currentUser) {
    return <p className="text-center py-8">Please log in to manage maintenance logs.</p>;
  }


  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
      <div className="md:col-span-1">
        <Card>
          <CardHeader>
            <CardTitle className="font-headline flex items-center gap-2"><PlusCircle /> New Log</CardTitle>
            <CardDescription>Add a new maintenance entry.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="item"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Item/Appliance</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Dishwasher" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Notes</FormLabel>
                      <FormControl>
                        <Textarea placeholder="Describe the maintenance performed..." rows={5} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" className="w-full">Add Log</Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>

      <div className="md:col-span-2">
         <Card>
            <CardHeader>
                <CardTitle className="font-headline">History</CardTitle>
                <CardDescription>View and manage past maintenance logs.</CardDescription>
            </CardHeader>
            <CardContent>
                <Accordion type="single" collapsible className="w-full space-y-2">
                {logs.map((log) => (
                    <AccordionItem value={log.id} key={log.id} className="border rounded-lg px-4 bg-background">
                    <AccordionTrigger className="hover:no-underline">
                        <div className="flex justify-between w-full pr-4">
                            <span className="font-semibold">{log.item}</span>
                            <span className="text-sm text-muted-foreground">{format(new Date(log.date), 'PPP')}</span>
                        </div>
                    </AccordionTrigger>
                    <AccordionContent className="pt-2 pb-4">
                        <p className="text-sm text-muted-foreground mb-4 whitespace-pre-wrap">{log.notes}</p>
                        
                        {summaries[log.id] && (
                            <div className="p-4 bg-primary/10 rounded-md mb-4 border border-primary/20">
                                <h4 className="font-semibold text-primary flex items-center gap-2 mb-2"><Sparkles className="w-4 h-4"/> AI Summary</h4>
                                <p className="text-sm">{summaries[log.id]}</p>
                            </div>
                        )}

                        <Button 
                            onClick={() => handleSummarize(log)} 
                            disabled={loadingStates[log.id]}
                        >
                        {loadingStates[log.id] ? (
                            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating...</>
                        ) : (
                           <><Sparkles className="mr-2 h-4 w-4" /> Summarize with AI</>
                        )}
                        </Button>
                    </AccordionContent>
                    </AccordionItem>
                ))}
                 {logs.length === 0 && <p className="text-center text-muted-foreground py-4">No logs yet.</p>}
                </Accordion>
            </CardContent>
         </Card>
      </div>
    </div>
  );
}
