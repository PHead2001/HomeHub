
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/hooks/use-auth';
import { getHomeAssistantEntities } from '@/app/automation/actions';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Settings, List, Unplug } from 'lucide-react';
import type { HomeAssistantEntity } from '@/lib/types';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { db } from '@/lib/firebase';
import { doc, getDoc } from 'firebase/firestore';
import { buttonVariants } from './ui/button';

const credentialsSchema = z.object({
    url: z.string().url('Please enter a valid URL (e.g., http://homeassistant.local:8123).'),
    accessToken: z.string().min(1, 'A Long-Lived Access Token is required.'),
});

function CredentialsForm({
  isSubmitting,
  onSubmit,
}: {
  isSubmitting: boolean;
  onSubmit: (values: z.infer<typeof credentialsSchema>) => void;
}) {
  const form = useForm<z.infer<typeof credentialsSchema>>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: {
        url: '',
        accessToken: ''
    },
  });

  return (
    <Card className="max-w-lg mx-auto">
        <CardHeader>
            <CardTitle className="font-headline flex items-center gap-2"><Settings/> Home Assistant Setup</CardTitle>
            <CardDescription>
                Connect to your Home Assistant instance to control your smart devices. You can create a Long-Lived Access Token in your Home Assistant profile page.
            </CardDescription>
        </CardHeader>
        <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)}>
                <CardContent className="space-y-4">
                    <FormField
                        control={form.control}
                        name="url"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Instance URL</FormLabel>
                                <FormControl>
                                    <Input placeholder="http://homeassistant.local:8123" {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                    <FormField
                        control={form.control}
                        name="accessToken"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Long-Lived Access Token</FormLabel>
                                <FormControl>
                                    <Input type="password" placeholder="Paste your token here" {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                </CardContent>
                <CardFooter>
                    <Button type="submit" disabled={isSubmitting}>
                        {isSubmitting && <Loader2 className="mr-2 animate-spin" />}
                        Save & Connect
                    </Button>
                </CardFooter>
            </form>
        </Form>
    </Card>
  );
}

export function AutomationClient() {
  const { currentUser, saveHomeAssistantCredentials, disconnectHomeAssistant } = useAuth();
  const { toast } = useToast();
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [entities, setEntities] = useState<HomeAssistantEntity[]>([]);
  const [isConfigured, setIsConfigured] = useState(false);
  const [isDisconnectAlertOpen, setIsDisconnectAlertOpen] = useState(false);
  
  const handleFetchEntities = useCallback(async () => {
      setIsLoading(true);
      setEntities([]);
      try {
          const result = await getHomeAssistantEntities(currentUser?.email, currentUser?.householdId ?? undefined);
          if (result.error) {
              toast({ variant: 'destructive', title: 'Connection Failed', description: result.error });
              // If fetching fails, maybe the token is bad. Ask user to reconnect.
              setIsConfigured(false);
          } else if (result.data) {
              setEntities(result.data);
          }
      } catch {
          toast({ variant: 'destructive', title: 'Error', description: 'An unexpected error occurred.' });
      } finally {
          setIsLoading(false);
      }
  }, [currentUser?.email, currentUser?.householdId, toast]);

  const checkConfiguration = useCallback(async () => {
    if (!currentUser?.householdId) {
        setIsLoading(false);
        return;
    };
    const configDocRef = doc(db, 'households', currentUser.householdId, 'home-automation', 'credentials');
    try {
        setIsLoading(true);
        const docSnap = await getDoc(configDocRef);
        const configured = docSnap.exists();
        setIsConfigured(configured);
        if (configured) {
            handleFetchEntities();
        }
    } catch (error) {
        console.error("Error checking HA config:", error);
        toast({ variant: 'destructive', title: 'Error', description: 'Could not check Home Assistant configuration.' });
        setIsConfigured(false);
    } finally {
        setIsLoading(false);
    }
  }, [currentUser?.householdId, handleFetchEntities, toast]);

  const handleSaveCredentials = async (values: z.infer<typeof credentialsSchema>) => {
    setIsSubmitting(true);
    await saveHomeAssistantCredentials(values);
    await checkConfiguration(); // Re-check config and fetch entities
    setIsSubmitting(false);
  };
  
  const handleDisconnect = async () => {
    setIsDisconnectAlertOpen(false);
    await disconnectHomeAssistant();
    setIsConfigured(false);
    setEntities([]);
  }

  useEffect(() => {
    if (currentUser?.householdId) {
        checkConfiguration();
    } else {
        setIsLoading(false);
    }
  }, [currentUser?.householdId, checkConfiguration]);

  if (isLoading) {
    return (
        <div className="flex justify-center items-center py-32">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="ml-4 text-muted-foreground">Loading Automation Hub...</p>
        </div>
    )
  }

  if (!isConfigured) {
    return (
        <div className="flex items-center justify-center py-16">
            <CredentialsForm
                isSubmitting={isSubmitting}
                onSubmit={handleSaveCredentials}
            />
        </div>
    );
  }

  return (
    <>
        <AlertDialog open={isDisconnectAlertOpen} onOpenChange={setIsDisconnectAlertOpen}>
            <AlertDialogContent>
            <AlertDialogHeader>
                <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                <AlertDialogDescription>
                This will disconnect your Home Assistant instance. You will need to re-enter your URL and Access Token to connect again.
                </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                    onClick={handleDisconnect}
                    className={buttonVariants({ variant: "destructive" })}
                >
                    Disconnect
                </AlertDialogAction>
            </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>

        <Card>
            <CardHeader className="flex flex-row items-center justify-between">
                <div>
                    <CardTitle className="font-headline flex items-center gap-2"><List/> Your Devices</CardTitle>
                    <CardDescription>
                        A list of all entities found in your Home Assistant instance.
                    </CardDescription>
                </div>
                <Button variant="destructive" onClick={() => setIsDisconnectAlertOpen(true)}>
                    <Unplug className="mr-2"/> Disconnect
                </Button>
            </CardHeader>
            <CardContent>
                <div className="max-h-[600px] overflow-y-auto">
                    <Table>
                        <TableHeader className="sticky top-0 bg-background">
                            <TableRow>
                                <TableHead>Friendly Name</TableHead>
                                <TableHead>Entity ID</TableHead>
                                <TableHead>State</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {entities.length > 0 ? (
                                entities.map(entity => (
                                    <TableRow key={entity.entity_id}>
                                        <TableCell className="font-medium">{entity.attributes.friendly_name || entity.entity_id}</TableCell>
                                        <TableCell className="text-muted-foreground font-mono text-xs">{entity.entity_id}</TableCell>
                                        <TableCell>
                                            <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground">
                                                {entity.state}
                                            </span>
                                        </TableCell>
                                    </TableRow>
                                ))
                            ) : (
                                <TableRow>
                                    <TableCell colSpan={3} className="text-center text-muted-foreground h-24">
                                        No devices found or failed to connect.
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </div>
            </CardContent>
        </Card>
    </>
  );
}
