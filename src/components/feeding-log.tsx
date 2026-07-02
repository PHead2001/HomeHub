
"use client";

import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { format, parse } from 'date-fns';
import type { FeedingLog } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { PlusCircle, Trash2, CalendarIcon } from 'lucide-react';
import { Skeleton } from './ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import { collection, getDocs, deleteDoc, doc, orderBy, query, Timestamp, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Calendar } from './ui/calendar';
import { cn } from '@/lib/utils';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';

const logSchema = z.object({
  date: z.date(),
  time: z.string().regex(/^(0?[1-9]|1[0-2]):[0-5][0-9]$/, "Invalid time format (HH:MM)"),
  ampm: z.enum(['AM', 'PM']),
  cups: z.coerce.number().min(0.5, 'Amount must be at least 0.5.'),
  foodAmountType: z.enum(['Cups', 'Cans', 'Scoops', 'Other']),
  foodType: z.enum(['Dry', 'Wet', 'Mix']),
  comments: z.string().optional(),
});

interface FeedingLogProps {
    petId: string;
}

export function FeedingLogClient({ petId }: FeedingLogProps) {
  const { currentUser } = useAuth();
  const [logs, setLogs] = useState<FeedingLog[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();
  const [useCurrentTime, setUseCurrentTime] = useState(true);

  const getLogsCollectionRef = useCallback(() => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, 'pets', petId, 'feeding-logs');
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
      const logsData = querySnapshot.docs.map(doc => {
        const data = doc.data();
        let logDate: Date;

        if (data.date instanceof Timestamp) {
            logDate = data.date.toDate();
        } else if (typeof data.date === 'string') {
            logDate = new Date(data.date);
        } else {
            logDate = new Date(); // Fallback to now
        }

        return { 
          id: doc.id, 
          ...data,
          date: logDate
        } as FeedingLog
      });
      setLogs(logsData);
    } catch (error) {
      console.error("Error fetching feeding logs:", error);
      toast({ variant: 'destructive', title: 'Error', description: 'Could not fetch feeding logs.' });
    } finally {
      setLoading(false);
    }
  }, [getLogsCollectionRef, toast]);

  
  const form = useForm<z.infer<typeof logSchema>>({
    resolver: zodResolver(logSchema),
    defaultValues: { 
      date: new Date(), 
      time: format(new Date(), "hh:mm"), 
      ampm: format(new Date(), "a").toUpperCase() as 'AM' | 'PM',
      cups: 1, 
      foodAmountType: 'Cups', 
      foodType: 'Dry', 
      comments: '' 
    },
  });
  
  useEffect(() => {
    if (currentUser) {
      fetchLogs();
    }
  }, [currentUser, fetchLogs]);

  useEffect(() => {
    if (useCurrentTime) {
      const interval = setInterval(() => {
        const now = new Date();
        form.setValue('date', now);
        form.setValue('time', format(now, "hh:mm"));
        form.setValue('ampm', format(now, "a").toUpperCase() as 'AM' | 'PM');
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [useCurrentTime, form]);


  const onSubmit = async (values: z.infer<typeof logSchema>) => {
    const logsCollection = getLogsCollectionRef();
    if (!logsCollection) return;
    
    let finalDate: Date;
    if (useCurrentTime) {
      finalDate = new Date();
    } else {
      finalDate = parse(`${format(values.date, 'yyyy-MM-dd')} ${values.time} ${values.ampm}`, 'yyyy-MM-dd hh:mm a', new Date());
    }

    const newLog = {
      cups: values.cups,
      foodAmountType: values.foodAmountType,
      foodType: values.foodType,
      comments: values.comments,
      date: finalDate,
      // Store ampm for display consistency, though it's embedded in the date
      ampm: format(finalDate, 'a').toUpperCase() as 'AM' | 'PM',
    };

    try {
      const logId = (logs.length + 1).toString();
      await setDoc(doc(logsCollection, logId), newLog);

      form.reset({ 
          date: new Date(), 
          time: format(new Date(), "hh:mm"), 
          ampm: format(new Date(), "a").toUpperCase() as 'AM' | 'PM',
          cups: 1, 
          foodAmountType: 'Cups', 
          foodType: 'Dry', 
          comments: '' 
      });
      setUseCurrentTime(true);
      toast({ title: "Log added", description: "Feeding has been logged." });
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
        <CardTitle className="font-headline">Feeding Log</CardTitle>
        <CardDescription>Record feeding times and details.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 p-4 border rounded-lg">
            
            <div className="flex items-center space-x-2">
                <Checkbox id="useCurrentTime" checked={useCurrentTime} onCheckedChange={(checked) => setUseCurrentTime(!!checked)} />
                <label htmlFor="useCurrentTime" className="text-sm font-medium leading-none">Use current time</label>
            </div>
            
            <fieldset disabled={useCurrentTime} className="space-y-4 disabled:opacity-50">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                    control={form.control}
                    name="date"
                    render={({ field }) => (
                        <FormItem className="flex flex-col">
                        <FormLabel>Date</FormLabel>
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
                                {field.value ? (
                                    format(field.value, "PPP")
                                ) : (
                                    <span>Pick a date</span>
                                )}
                                <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                                </Button>
                            </FormControl>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0" align="start">
                            <Calendar
                                mode="single"
                                selected={field.value}
                                onSelect={field.onChange}
                                disabled={(date) =>
                                date > new Date() || date < new Date("1900-01-01")
                                }
                                initialFocus
                            />
                            </PopoverContent>
                        </Popover>
                        <FormMessage />
                        </FormItem>
                    )}
                    />
                    <div className="grid grid-cols-3 gap-2 items-end">
                       <div className="col-span-2">
                         <FormField
                            control={form.control}
                            name="time"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Time</FormLabel>
                                    <FormControl>
                                        <Input placeholder="hh:mm" {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                       </div>
                        <FormField
                            control={form.control}
                            name="ampm"
                            render={({ field }) => (
                            <FormItem>
                                <FormControl>
                                <RadioGroup
                                    onValueChange={field.onChange}
                                    value={field.value}
                                    className="flex items-center space-x-2"
                                >
                                    <FormItem className="flex items-center space-x-1 space-y-0">
                                    <FormControl>
                                        <RadioGroupItem value="AM" />
                                    </FormControl>
                                    <FormLabel className="font-normal text-xs">AM</FormLabel>
                                    </FormItem>
                                    <FormItem className="flex items-center space-x-1 space-y-0">
                                    <FormControl>
                                        <RadioGroupItem value="PM" />
                                    </FormControl>
                                    <FormLabel className="font-normal text-xs">PM</FormLabel>
                                    </FormItem>
                                </RadioGroup>
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                            )}
                        />
                    </div>
                </div>
            </fieldset>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
               <FormField
                  control={form.control}
                  name="cups"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Amount</FormLabel>
                      <Select onValueChange={(v) => field.onChange(parseFloat(v))} defaultValue={String(field.value)}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select an amount" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Array.from({ length: 8 }, (_, i) => (i + 1) * 0.5).map(v => (
                            <SelectItem key={v} value={String(v)}>{v}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                 <FormField
                  control={form.control}
                  name="foodAmountType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Unit</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a unit" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                            <SelectItem value="Cups">Cups</SelectItem>
                            <SelectItem value="Cans">Cans</SelectItem>
                            <SelectItem value="Scoops">Scoops</SelectItem>
                            <SelectItem value="Other">Other</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
            </div>
             <FormField
                control={form.control}
                name="foodType"
                render={({ field }) => (
                  <FormItem className="space-y-3">
                    <FormLabel>Food Type</FormLabel>
                    <FormControl>
                      <RadioGroup
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                        className="flex items-center space-x-4"
                      >
                        <FormItem className="flex items-center space-x-2 space-y-0">
                          <FormControl>
                            <RadioGroupItem value="Dry" />
                          </FormControl>
                          <FormLabel className="font-normal">Dry</FormLabel>
                        </FormItem>
                        <FormItem className="flex items-center space-x-2 space-y-0">
                          <FormControl>
                            <RadioGroupItem value="Wet" />
                          </FormControl>
                          <FormLabel className="font-normal">Wet</FormLabel>
                        </FormItem>
                        <FormItem className="flex items-center space-x-2 space-y-0">
                          <FormControl>
                            <RadioGroupItem value="Mix" />
                          </FormControl>
                          <FormLabel className="font-normal">Mix</FormLabel>
                        </FormItem>
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            <FormField
              control={form.control}
              name="comments"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Comments (Optional)</FormLabel>
                  <FormControl>
                    <Textarea placeholder="e.g. Mixed with a little water." rows={3} {...field} />
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
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                </div>
            )}
            {!loading && logs.length === 0 && (
                <p className="text-sm text-center text-muted-foreground py-4">No feeding logs yet.</p>
            )}
            {!loading && logs.map(log => (
                <div key={log.id} className="flex justify-between items-start text-sm p-3 bg-secondary/50 rounded-md">
                    <div>
                        <p className="font-medium">{format(new Date(log.date), 'PPP p')}</p>
                        <p className="font-semibold text-foreground">{log.cups} {log.foodAmountType} of {log.foodType} food</p>
                        {log.comments && <p className="text-muted-foreground mt-1">{log.comments}</p>}
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
