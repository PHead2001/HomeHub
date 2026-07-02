
'use client';

import Link from 'next/link';
import { DashboardCard } from '@/components/dashboard-card';
import { Button } from '@/components/ui/button';
import { PawPrint, Wrench, PlusCircle, ListTodo, Bot, ShoppingCart } from 'lucide-react';
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel"

export default function Home() {
  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="font-headline text-3xl font-bold tracking-tight">Welcome Home</h1>
        <p className="text-muted-foreground">Here&apos;s what&apos;s happening in your hub today.</p>
      </div>
      
      <section className="mb-10">
        <h2 className="font-headline text-xl font-semibold mb-4 border-b pb-2">Quick Actions</h2>
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" asChild><Link href="/shopping"><ShoppingCart className="mr-2" /> Add Shopping Item</Link></Button>
          <Button variant="outline" asChild><Link href="/maintenance"><Wrench className="mr-2" /> Log Maintenance</Link></Button>
          <Button variant="outline" asChild><Link href="/chores"><ListTodo className="mr-2" /> New Chore</Link></Button>
          <Button variant="outline" asChild><Link href="/pets"><PlusCircle className="mr-2" /> Add Pet</Link></Button>
        </div>
      </section>

      <section>
        <h2 className="font-headline text-xl font-semibold mb-4 border-b pb-2">Your Dashboard</h2>
        <Carousel
          opts={{
            align: "start",
          }}
          className="w-full"
        >
          <CarouselContent className="-ml-4">
            <CarouselItem className="pl-4 md:basis-1/2 lg:basis-1/3">
              <DashboardCard
                title="Shopping"
                description="Manage your shopping lists and pantry"
                icon={ShoppingCart}
                href="/shopping"
              />
            </CarouselItem>
             <CarouselItem className="pl-4 md:basis-1/2 lg:basis-1/3">
              <DashboardCard
                title="Pets"
                description="Manage your furry friends"
                icon={PawPrint}
                href="/pets"
              />
            </CarouselItem>
            <CarouselItem className="pl-4 md:basis-1/2 lg:basis-1/3">
              <DashboardCard
                title="Maintenance"
                description="Track home repairs and tasks"
                icon={Wrench}
                href="/maintenance"
              />
            </CarouselItem>
            <CarouselItem className="pl-4 md:basis-1/2 lg:basis-1/3">
              <DashboardCard
                title="Chore Chart"
                description="View and manage household tasks"
                icon={ListTodo}
                href="/chores"
              />
            </CarouselItem>
            <CarouselItem className="pl-4 md:basis-1/2 lg:basis-1/3">
              <DashboardCard
                title="House Automation"
                description="Control your smart devices"
                icon={Bot}
                href="/automation"
              />
            </CarouselItem>
          </CarouselContent>
          <CarouselPrevious />
          <CarouselNext />
        </Carousel>
      </section>
    </div>
  );
}
