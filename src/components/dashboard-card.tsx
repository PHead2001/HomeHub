import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Button } from './ui/button';
import { ArrowRight } from 'lucide-react';

interface DashboardCardProps {
  title: string;
  description: string;
  icon: LucideIcon;
  href: string;
}

export function DashboardCard({ title, description, icon: Icon, href }: DashboardCardProps) {
  return (
    <Card className="flex flex-col justify-between hover:shadow-md transition-shadow duration-200">
      <CardHeader>
        <div className="mb-4 bg-primary/10 p-3 rounded-full w-fit">
          <Icon className="h-6 w-6 text-primary" />
        </div>
        <CardTitle className="font-headline text-xl">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardFooter>
          <Button asChild variant="secondary" className="w-full">
              <Link href={href}>
                  View {title}
                  <ArrowRight className="ml-2" />
              </Link>
          </Button>
      </CardFooter>
    </Card>
  );
}
