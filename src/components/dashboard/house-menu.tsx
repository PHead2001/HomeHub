'use client';

/**
 * The house's "…" menu (HP-18a): the member's own display settings for the house,
 * out of the hero so a passer-by cannot flip them by accident. Each switch is a
 * `menuitemcheckbox` with a static label ("Live weather", "Seasonal touches"); its
 * state is `aria-checked` and the check mark, so it is announced once (HP-28a).
 */
import { CloudSun, MapPin, MoreHorizontal, Sparkles } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { WeatherSettings } from './weather-controls';
import styles from './dashboard.module.css';

export function HouseMenu({
  weather,
  seasonal,
}: {
  weather: WeatherSettings;
  /** Present only while a season is active (otherwise there is nothing to switch). */
  seasonal?: { on: boolean; toggle: () => void };
}) {
  if (!weather.ready && !seasonal) return null;
  const { preference } = weather;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="House settings"
          data-testid="house-menu"
          className={cn(styles.hitSlop, 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-ui hover:bg-muted hover:text-foreground')}
        >
          <MoreHorizontal aria-hidden className="h-5 w-5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionPadding={8}
        // Never wider than the room Radix measured beside the trigger (or the screen), so
        // a long weather city truncates inside the menu instead of widening it.
        className="min-w-[min(13rem,var(--radix-dropdown-menu-content-available-width,100vw))] max-w-[min(20rem,var(--radix-dropdown-menu-content-available-width,100vw))]"
        onCloseAutoFocus={(event) => {
          // When this menu opened the city form, focus goes (back) to its field, not the
          // trigger: the closing menu may have taken it from the field in the meantime.
          if (weather.menuClosed()) event.preventDefault();
        }}
      >
        {weather.ready && (
          <DropdownMenuCheckboxItem
            checked={preference.enabled}
            disabled={weather.saving}
            onCheckedChange={() => void weather.toggle()}
            data-testid="weather-toggle"
            className={cn(styles.menuItem, 'gap-2')}
          >
            <CloudSun aria-hidden className="h-4 w-4" />
            Live weather
          </DropdownMenuCheckboxItem>
        )}
        {weather.ready && preference.enabled && preference.city && (
          <DropdownMenuItem onSelect={weather.startEditing} data-testid="weather-city-edit" className={cn(styles.menuItem, 'pl-8')}>
            <MapPin aria-hidden />
            <span className="min-w-0 truncate" title={preference.city}>Change weather city ({preference.city})</span>
          </DropdownMenuItem>
        )}
        {seasonal && (
          <DropdownMenuCheckboxItem
            checked={seasonal.on}
            onCheckedChange={seasonal.toggle}
            data-testid="seasonal-toggle"
            className={cn(styles.menuItem, 'gap-2')}
          >
            <Sparkles aria-hidden className="h-4 w-4" />
            Seasonal touches
          </DropdownMenuCheckboxItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
