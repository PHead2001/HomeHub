// Brand matching for asset and vehicle cards (H30). Pure and dependency-free so
// it is unit-tested; the logo artwork itself lives in a lazily loaded chunk
// (`src/components/brand/brand-marks.ts`). A brand with no artwork still gets a
// consistent monogram badge (`mark`), never a hand-drawn imitation of a logo.

export type BrandCategory =
  | 'vehicle'
  | 'appliance'
  | 'kitchen'
  | 'cleaning'
  | 'hvac'
  | 'electronics'
  | 'tools'
  | 'plumbing'
  | 'pool';

export type BrandEntry = {
  /** Stable id; also the key into the lazily loaded artwork chunk. */
  id: string;
  /** Display and accessible name, e.g. "Mercedes-Benz". */
  name: string;
  category: BrandCategory;
  /** Other spellings and sub-brands that mean this brand. */
  aliases?: string[];
  /** Badge text when no artwork exists; defaults from the name. */
  mark?: string;
};

const b = (id: string, name: string, category: BrandCategory, aliases?: string[], mark?: string): BrandEntry => ({ id, name, category, aliases, mark });

export const BRANDS: BrandEntry[] = [
  // Cars and motorcycles
  b('acura', 'Acura', 'vehicle'),
  b('alfaromeo', 'Alfa Romeo', 'vehicle', ['Alfa']),
  b('astonmartin', 'Aston Martin', 'vehicle'),
  b('audi', 'Audi', 'vehicle'),
  b('bentley', 'Bentley', 'vehicle'),
  b('bmw', 'BMW', 'vehicle', ['Bayerische Motoren Werke']),
  b('buick', 'Buick', 'vehicle'),
  b('cadillac', 'Cadillac', 'vehicle', ['Caddy']),
  b('chevrolet', 'Chevrolet', 'vehicle', ['Chevy', 'Chev']),
  b('chrysler', 'Chrysler', 'vehicle'),
  b('dodge', 'Dodge', 'vehicle'),
  b('ferrari', 'Ferrari', 'vehicle'),
  b('fiat', 'Fiat', 'vehicle'),
  b('ford', 'Ford', 'vehicle', ['Ford Motor', 'Ford Motor Company']),
  b('genesis', 'Genesis', 'vehicle'),
  b('gmc', 'GMC', 'vehicle', ['General Motors Truck']),
  b('honda', 'Honda', 'vehicle', ['Honda Power', 'Honda Power Equipment', 'Honda Power Sports', 'Honda Motorcycles']),
  b('hyundai', 'Hyundai', 'vehicle'),
  b('infiniti', 'Infiniti', 'vehicle'),
  b('jaguar', 'Jaguar', 'vehicle', ['Jag']),
  b('jeep', 'Jeep', 'vehicle'),
  b('kia', 'Kia', 'vehicle'),
  b('lamborghini', 'Lamborghini', 'vehicle'),
  b('landrover', 'Land Rover', 'vehicle', ['Range Rover'], 'LR'),
  b('lexus', 'Lexus', 'vehicle'),
  b('lincoln', 'Lincoln', 'vehicle'),
  b('lucid', 'Lucid', 'vehicle', ['Lucid Motors']),
  b('maserati', 'Maserati', 'vehicle'),
  b('mazda', 'Mazda', 'vehicle'),
  b('mclaren', 'McLaren', 'vehicle'),
  b('mercedes', 'Mercedes-Benz', 'vehicle', ['Mercedes', 'Benz', 'Merc', 'Mercedes Benz USA'], 'MB'),
  b('mini', 'Mini', 'vehicle', ['Mini Cooper']),
  b('mitsubishi', 'Mitsubishi', 'vehicle', ['Mitsubishi Motors']),
  b('nissan', 'Nissan', 'vehicle'),
  b('polestar', 'Polestar', 'vehicle'),
  b('porsche', 'Porsche', 'vehicle'),
  b('ram', 'Ram', 'vehicle', ['Ram Trucks']),
  b('rivian', 'Rivian', 'vehicle'),
  b('rollsroyce', 'Rolls-Royce', 'vehicle', ['Rolls'], 'RR'),
  b('subaru', 'Subaru', 'vehicle'),
  b('tesla', 'Tesla', 'vehicle'),
  b('toyota', 'Toyota', 'vehicle'),
  b('volkswagen', 'Volkswagen', 'vehicle', ['VW', 'Volkswagon'], 'VW'),
  b('volvo', 'Volvo', 'vehicle'),
  b('harleydavidson', 'Harley-Davidson', 'vehicle', ['Harley', 'HD'], 'H-D'),
  b('yamaha', 'Yamaha', 'vehicle', ['Yamaha Motor']),
  b('kawasaki', 'Kawasaki', 'vehicle'),
  b('suzuki', 'Suzuki', 'vehicle'),
  b('ducati', 'Ducati', 'vehicle'),
  b('triumph', 'Triumph', 'vehicle', ['Triumph Motorcycles']),
  b('indian', 'Indian Motorcycle', 'vehicle', ['Indian', 'Indian Motorcycles']),
  b('ktm', 'KTM', 'vehicle'),
  b('polaris', 'Polaris', 'vehicle'),
  b('canam', 'Can-Am', 'vehicle', ['BRP']),
  // Major appliances
  b('whirlpool', 'Whirlpool', 'appliance'),
  b('frigidaire', 'Frigidaire', 'appliance', ['Frigidaire Gallery', 'Frigidaire Professional']),
  b('ge', 'GE', 'appliance', ['GE Appliances', 'General Electric']),
  b('geprofile', 'GE Profile', 'appliance', [], 'GE'),
  b('cafe', 'Café', 'appliance', ['GE Cafe', 'Cafe Appliances']),
  b('samsung', 'Samsung', 'appliance', ['Samsung Electronics']),
  b('lg', 'LG', 'appliance', ['LG Electronics', 'LG Studio']),
  b('bosch', 'Bosch', 'appliance', ['Bosch Tools', 'Robert Bosch']),
  b('kitchenaid', 'KitchenAid', 'appliance', ['Kitchen Aid'], 'KA'),
  b('maytag', 'Maytag', 'appliance'),
  b('electrolux', 'Electrolux', 'appliance'),
  b('kenmore', 'Kenmore', 'appliance', ['Kenmore Elite', 'Sears Kenmore']),
  b('amana', 'Amana', 'appliance'),
  b('haier', 'Haier', 'appliance'),
  b('hotpoint', 'Hotpoint', 'appliance'),
  b('subzero', 'Sub-Zero', 'appliance', ['Subzero'], 'SZ'),
  b('wolf', 'Wolf', 'appliance', ['Wolf Appliances']),
  b('thermador', 'Thermador', 'appliance'),
  b('jennair', 'JennAir', 'appliance', ['Jenn-Air', 'Jenn Air'], 'JA'),
  b('miele', 'Miele', 'appliance'),
  b('fisherpaykel', 'Fisher & Paykel', 'appliance', ['Fisher Paykel', 'F&P'], 'F&P'),
  b('speedqueen', 'Speed Queen', 'appliance'),
  b('viking', 'Viking', 'appliance', ['Viking Range']),
  b('beko', 'Beko', 'appliance'),
  b('dacor', 'Dacor', 'appliance'),
  b('summit', 'Summit', 'appliance', ['Summit Appliance']),
  // Small kitchen
  b('ninja', 'Ninja', 'kitchen', ['SharkNinja', 'Shark Ninja', 'Ninja Kitchen', 'Ninja Foodi']),
  b('instantpot', 'Instant Pot', 'kitchen', ['Instant', 'Instant Brands', 'InstantPot'], 'IP'),
  b('keurig', 'Keurig', 'kitchen'),
  b('nespresso', 'Nespresso', 'kitchen'),
  b('breville', 'Breville', 'kitchen'),
  b('cuisinart', 'Cuisinart', 'kitchen'),
  b('vitamix', 'Vitamix', 'kitchen', ['Vita-Mix']),
  b('hamiltonbeach', 'Hamilton Beach', 'kitchen'),
  b('oster', 'Oster', 'kitchen'),
  b('crockpot', 'Crock-Pot', 'kitchen', ['Crockpot', 'Crock Pot']),
  b('smeg', 'Smeg', 'kitchen'),
  b('delonghi', "De'Longhi", 'kitchen', ['Delonghi', 'De Longhi'], 'DL'),
  b('zojirushi', 'Zojirushi', 'kitchen'),
  b('sunbeam', 'Sunbeam', 'kitchen'),
  b('mrcoffee', 'Mr. Coffee', 'kitchen', ['Mister Coffee']),
  b('panasonic', 'Panasonic', 'electronics'),
  b('philips', 'Philips', 'electronics'),
  // Vacuums and cleaning
  b('dyson', 'Dyson', 'cleaning'),
  b('shark', 'Shark', 'cleaning', ['Shark Vacuum']),
  b('irobot', 'iRobot', 'cleaning', ['Roomba', 'Braava']),
  b('bissell', 'Bissell', 'cleaning'),
  b('hoover', 'Hoover', 'cleaning'),
  b('eureka', 'Eureka', 'cleaning'),
  b('roborock', 'Roborock', 'cleaning'),
  b('ecovacs', 'Ecovacs', 'cleaning', ['Deebot']),
  b('tineco', 'Tineco', 'cleaning'),
  b('karcher', 'Kärcher', 'cleaning', ['Karcher', 'Kaercher']),
  // HVAC and water
  b('trane', 'Trane', 'hvac'),
  b('carrier', 'Carrier', 'hvac'),
  b('lennox', 'Lennox', 'hvac'),
  b('rheem', 'Rheem', 'hvac'),
  b('ruud', 'Ruud', 'hvac'),
  b('goodman', 'Goodman', 'hvac'),
  b('daikin', 'Daikin', 'hvac'),
  b('mitsubishielectric', 'Mitsubishi Electric', 'hvac', ['Mitsubishi Electric Trane'], 'ME'),
  b('aosmith', 'A.O. Smith', 'hvac', ['AO Smith', 'A O Smith', 'AOSmith'], 'AOS'),
  b('bradfordwhite', 'Bradford White', 'hvac'),
  b('rinnai', 'Rinnai', 'hvac'),
  b('navien', 'Navien', 'hvac'),
  b('culligan', 'Culligan', 'hvac'),
  b('bryant', 'Bryant', 'hvac'),
  b('york', 'York', 'hvac'),
  b('aprilaire', 'Aprilaire', 'hvac'),
  b('fujitsu', 'Fujitsu', 'hvac'),
  b('kinetico', 'Kinetico', 'hvac'),
  b('statewater', 'State Water Heaters', 'hvac'),
  // Smart home and electronics
  b('googlenest', 'Google Nest', 'electronics', ['Nest', 'Nest Labs', 'Nest Thermostat']),
  b('google', 'Google', 'electronics', ['Google Pixel', 'Chromecast']),
  b('ecobee', 'Ecobee', 'electronics'),
  b('ring', 'Ring', 'electronics'),
  b('arlo', 'Arlo', 'electronics'),
  b('philipshue', 'Philips Hue', 'electronics', ['Hue']),
  b('apple', 'Apple', 'electronics'),
  b('sony', 'Sony', 'electronics'),
  b('roku', 'Roku', 'electronics'),
  b('vizio', 'Vizio', 'electronics'),
  b('tcl', 'TCL', 'electronics'),
  b('hisense', 'Hisense', 'electronics'),
  b('sonos', 'Sonos', 'electronics'),
  b('bose', 'Bose', 'electronics'),
  b('amazon', 'Amazon', 'electronics', ['Amazon Echo', 'Alexa', 'Echo Dot', 'Kindle', 'Fire TV']),
  b('honeywell', 'Honeywell', 'electronics', ['Honeywell Home', 'Resideo']),
  b('kwikset', 'Kwikset', 'electronics'),
  b('schlage', 'Schlage', 'electronics'),
  b('chamberlain', 'Chamberlain', 'electronics', ['myQ']),
  b('liftmaster', 'LiftMaster', 'electronics', ['Lift Master']),
  b('genie', 'Genie', 'electronics', ['Genie Garage']),
  b('wyze', 'Wyze', 'electronics'),
  b('eufy', 'Eufy', 'electronics', ['Anker Eufy']),
  b('simplisafe', 'SimpliSafe', 'electronics', ['Simpli Safe']),
  b('adt', 'ADT', 'electronics'),
  b('lutron', 'Lutron', 'electronics', ['Caseta']),
  b('leviton', 'Leviton', 'electronics'),
  b('tplink', 'TP-Link', 'electronics', ['Kasa', 'Tapo', 'TPLink', 'Deco'], 'TP'),
  b('netgear', 'Netgear', 'electronics', ['Orbi']),
  b('eero', 'Eero', 'electronics'),
  b('linksys', 'Linksys', 'electronics'),
  b('asus', 'ASUS', 'electronics'),
  b('ubiquiti', 'Ubiquiti', 'electronics', ['UniFi']),
  b('microsoft', 'Microsoft', 'electronics', ['Xbox', 'Surface']),
  b('nintendo', 'Nintendo', 'electronics'),
  b('playstation', 'PlayStation', 'electronics'),
  b('dell', 'Dell', 'electronics'),
  b('hp', 'HP', 'electronics', ['Hewlett Packard', 'Hewlett-Packard']),
  b('lenovo', 'Lenovo', 'electronics'),
  b('canon', 'Canon', 'electronics'),
  b('epson', 'Epson', 'electronics'),
  b('brother', 'Brother', 'electronics'),
  b('apc', 'APC', 'electronics', ['APC by Schneider Electric']),
  b('aqara', 'Aqara', 'electronics'),
  b('smartthings', 'SmartThings', 'electronics', ['Samsung SmartThings']),
  b('homeassistant', 'Home Assistant', 'electronics'),
  // Tools, lawn and garden
  b('dewalt', 'DeWalt', 'tools', ['De Walt']),
  b('milwaukee', 'Milwaukee', 'tools', ['Milwaukee Tool']),
  b('makita', 'Makita', 'tools'),
  b('ryobi', 'Ryobi', 'tools'),
  b('craftsman', 'Craftsman', 'tools'),
  b('blackdecker', 'Black+Decker', 'tools', ['Black & Decker', 'Black and Decker', 'BlackDecker'], 'B+D'),
  b('stihl', 'Stihl', 'tools'),
  b('husqvarna', 'Husqvarna', 'tools'),
  b('toro', 'Toro', 'tools'),
  b('johndeere', 'John Deere', 'tools', ['Deere'], 'JD'),
  b('cubcadet', 'Cub Cadet', 'tools'),
  b('ego', 'EGO', 'tools', ['EGO Power', 'EGO Power+']),
  b('greenworks', 'Greenworks', 'tools'),
  b('generac', 'Generac', 'tools'),
  b('weber', 'Weber', 'tools', ['Weber Grills']),
  b('traeger', 'Traeger', 'tools', ['Traeger Grills']),
  b('kobalt', 'Kobalt', 'tools'),
  b('ridgid', 'Ridgid', 'tools'),
  b('worx', 'Worx', 'tools'),
  b('briggsstratton', 'Briggs & Stratton', 'tools', ['Briggs', 'Briggs and Stratton'], 'B&S'),
  b('troybilt', 'Troy-Bilt', 'tools', ['Troybilt', 'Troy Built']),
  b('snapper', 'Snapper', 'tools'),
  b('kubota', 'Kubota', 'tools'),
  b('chargriller', 'Char-Griller', 'tools'),
  b('charbroil', 'Char-Broil', 'tools', ['Charbroil']),
  b('pitboss', 'Pit Boss', 'tools'),
  b('biggreenegg', 'Big Green Egg', 'tools', [], 'BGE'),
  b('festool', 'Festool', 'tools'),
  b('hilti', 'Hilti', 'tools'),
  b('skil', 'Skil', 'tools'),
  b('portercable', 'Porter-Cable', 'tools', ['Porter Cable'], 'PC'),
  b('rainbird', 'Rain Bird', 'tools', ['Rainbird']),
  b('orbit', 'Orbit', 'tools', ['B-hyve']),
  b('champion', 'Champion Power Equipment', 'tools', ['Champion']),
  b('westinghouse', 'Westinghouse', 'tools'),
  // Plumbing and fixtures
  b('kohler', 'Kohler', 'plumbing'),
  b('moen', 'Moen', 'plumbing'),
  b('delta', 'Delta', 'plumbing', ['Delta Faucet']),
  b('americanstandard', 'American Standard', 'plumbing', [], 'AS'),
  b('insinkerator', 'InSinkErator', 'plumbing', ['In-Sink-Erator', 'In Sink Erator'], 'ISE'),
  b('pfister', 'Pfister', 'plumbing', ['Price Pfister']),
  b('grohe', 'Grohe', 'plumbing'),
  b('toto', 'Toto', 'plumbing'),
  b('hansgrohe', 'Hansgrohe', 'plumbing'),
  b('glacierbay', 'Glacier Bay', 'plumbing'),
  b('zurn', 'Zurn', 'plumbing'),
  // Pool
  b('pentair', 'Pentair', 'pool'),
  b('hayward', 'Hayward', 'pool'),
  b('zodiac', 'Zodiac', 'pool', ['Zodiac Pool']),
  b('jandy', 'Jandy', 'pool'),
  b('intex', 'Intex', 'pool'),
];

/** Words that carry no brand: a company suffix or a product-line noun. */
const SUFFIX_WORDS = new Set([
  'inc', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company', 'usa', 'us', 'america', 'americas', 'na',
  'appliance', 'appliances', 'electronics', 'brand', 'brands', 'group', 'motors', 'motor', 'automotive',
  'home', 'products', 'manufacturing', 'mfg',
]);

/** Values people type when there is no brand; never fuzzy-matched to a real one. */
const NO_BRAND = new Set(['generic', 'unknown', 'none', 'na', 'other', 'unbranded', 'storebrand', 'misc', 'various', 'nobrand', 'tbd', 'custom']);

/** Lowercase words with accents, punctuation, "&", "+" and the word "and" removed. */
export function brandWords(input: string): string[] {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[&+]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word && word !== 'and');
}

/** One comparison key: words joined, with trailing company suffixes dropped. */
export function normalizeBrand(input: string): string {
  const words = brandWords(input);
  while (words.length > 1 && SUFFIX_WORDS.has(words[words.length - 1])) words.pop();
  return words.join('');
}

/**
 * Optimal-string-alignment Damerau-Levenshtein distance (insert, delete,
 * substitute, swap two neighbours), abandoned once it exceeds `max`.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) rows.push([i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2][j - 2] + 1);
      rows[i][j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
  }
  return rows[a.length][b.length];
}

/** Typos allowed for a key: none up to 4 letters, 1 for 5–7, 2 for 8 or more. */
export const allowedTypos = (length: number) => (length <= 4 ? 0 : length <= 7 ? 1 : 2);

type Index = { exact: Map<string, BrandEntry>; keys: Array<{ key: string; brand: BrandEntry }> };

const buildIndex = (catalog: BrandEntry[]): Index => {
  const exact = new Map<string, BrandEntry>();
  const keys: Index['keys'] = [];
  for (const brand of catalog) {
    for (const spelling of [brand.name, brand.id, ...(brand.aliases ?? [])]) {
      const key = normalizeBrand(spelling);
      if (!key || exact.has(key)) continue;
      exact.set(key, brand);
      keys.push({ key, brand });
    }
  }
  return { exact, keys };
};

const indexes = new WeakMap<BrandEntry[], Index>();
const indexFor = (catalog: BrandEntry[]) => {
  let index = indexes.get(catalog);
  if (!index) {
    index = buildIndex(catalog);
    indexes.set(catalog, index);
  }
  return index;
};

/**
 * The brand a free-text value names, or null. In order: the whole value (or a
 * known alias), then its leading words ("Whirlpool Gold" → Whirlpool), then a
 * typo-tolerant match on the whole value. Short names (4 letters or fewer, such
 * as GE, LG, Kia) only match exactly, and a typo that is equally close to two
 * different brands matches neither.
 */
export function matchBrand(input: string | null | undefined, catalog: BrandEntry[] = BRANDS): BrandEntry | null {
  if (!input) return null;
  const words = brandWords(input);
  const key = normalizeBrand(input);
  if (!key || NO_BRAND.has(key)) return null;
  const index = indexFor(catalog);

  const direct = index.exact.get(key);
  if (direct) return direct;
  for (let count = words.length - 1; count >= 1; count--) {
    const prefix = index.exact.get(words.slice(0, count).join(''));
    if (prefix) return prefix;
  }

  const budget = allowedTypos(key.length);
  if (budget === 0) return null;
  let best: BrandEntry | null = null;
  let bestDistance = Infinity;
  let tied = false;
  for (const candidate of index.keys) {
    const allowed = Math.min(budget, allowedTypos(candidate.key.length));
    if (allowed === 0) continue;
    const distance = editDistance(key, candidate.key, allowed);
    if (distance > allowed) continue;
    if (distance < bestDistance) {
      best = candidate.brand;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance && candidate.brand.id !== best?.id) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/** Badge text for a brand with no artwork: its short name, or initials. */
export function brandMark(brand: Pick<BrandEntry, 'name' | 'mark'>): string {
  if (brand.mark) return brand.mark;
  if (brand.name.length <= 6) return brand.name;
  const words = brand.name.split(/[\s-]+/).filter(Boolean);
  if (words.length > 1) return words.map((word) => word[0]).join('').toUpperCase().slice(0, 3);
  return brand.name[0].toUpperCase();
}
