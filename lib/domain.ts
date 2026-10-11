import type {
  GroceryCategory,
  GroceryItem,
  Ingredient,
  Rational,
  Recipe,
  RecipeDraft,
} from './types';

const VULGAR_FRACTIONS: Record<string, Rational> = {
  '¼': { numerator: 1, denominator: 4 },
  '⅓': { numerator: 1, denominator: 3 },
  '½': { numerator: 1, denominator: 2 },
  '⅔': { numerator: 2, denominator: 3 },
  '¾': { numerator: 3, denominator: 4 },
  '⅛': { numerator: 1, denominator: 8 },
  '⅜': { numerator: 3, denominator: 8 },
  '⅝': { numerator: 5, denominator: 8 },
  '⅞': { numerator: 7, denominator: 8 },
  '⅙': { numerator: 1, denominator: 6 },
  '⅚': { numerator: 5, denominator: 6 },
  '⅕': { numerator: 1, denominator: 5 },
  '⅖': { numerator: 2, denominator: 5 },
  '⅗': { numerator: 3, denominator: 5 },
  '⅘': { numerator: 4, denominator: 5 },
};

/** The same fractions as ASCII text, substituted before NFKC normalization (which would turn "1½" into "11⁄2"). */
const ASCII_FRACTIONS: Record<string, string> = Object.fromEntries(
  Object.entries(VULGAR_FRACTIONS).map(([glyph, { numerator, denominator }]) => [glyph, `${numerator}/${denominator}`]),
);
const VULGAR = Object.keys(VULGAR_FRACTIONS).join('');
const VULGAR_GLYPH = new RegExp(`[${VULGAR}]`, 'g');
const MIXED_VULGAR = new RegExp(`(\\d)\\s?([${VULGAR}])`, 'g');
const MIXED_VULGAR_TOKEN = new RegExp(`^(\\d+)\\s?([${VULGAR}])$`);
/** A decimal written with a point or a comma ("1.5", ".5", "1,5"), or a thousands-grouped integer ("1,000"). */
const DECIMAL_TOKEN = '(?:\\d{1,3}(?:,\\d{3})+(?!\\d)|\\d+,\\d{1,2}(?!\\d)|\\d*\\.\\d+|\\d+)';
/** One numeric amount: "1 1/2", "1/2", "1½", "½", "1.5", ".5", "1,5", "600". */
const NUMBER_TOKEN = `(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+\\s?[${VULGAR}]|[${VULGAR}]|${DECIMAL_TOKEN})`;

/**
 * Vulgar fractions become ASCII before any NFKC normalization, which would otherwise turn "½" into "1⁄2" (U+2044,
 * which no quantity regex matches) and "1½" into "11⁄2". Used by the parser and by normalizeIngredientName so keys stay stable.
 */
function asciiFractions(text: string): string {
  return text
    .replace(MIXED_VULGAR, (_match, digit: string, fraction: string) => `${digit} ${ASCII_FRACTIONS[fraction]}`)
    .replace(VULGAR_GLYPH, (fraction) => ASCII_FRACTIONS[fraction])
    .normalize('NFKC')
    .replace(/⁄/g, '/');
}

/** Decimals that are really a fraction typed out: 0.33 is a third, 0.67 two thirds. Anything within 0.01 snaps. */
const DECIMAL_SNAPS: Rational[] = [
  { numerator: 1, denominator: 8 }, { numerator: 1, denominator: 6 }, { numerator: 1, denominator: 5 }, { numerator: 1, denominator: 4 },
  { numerator: 1, denominator: 3 }, { numerator: 3, denominator: 8 }, { numerator: 2, denominator: 5 }, { numerator: 1, denominator: 2 },
  { numerator: 5, denominator: 8 }, { numerator: 2, denominator: 3 }, { numerator: 3, denominator: 4 }, { numerator: 5, denominator: 6 },
  { numerator: 7, denominator: 8 },
];

type UnitDefinition = {
  code: string;
  family: string;
  factor: number;
  aliases: string[];
  /** Display form when the amount is more than one; omitted means the code never changes (tbsp, oz, g). */
  plural?: string;
  /** Amount words such as "splash" or "pinch" that only ever describe a rough quantity. */
  approximate?: boolean;
  /** A can, jar, bag or box: after a weight ("400g tin tomatoes") it becomes a note and the weight stays the measure. */
  container?: boolean;
};

const opaque = (code: string, plural: string, aliases: string[], flags: Pick<UnitDefinition, 'approximate' | 'container'> = {}): UnitDefinition =>
  ({ code, family: `opaque:${code}`, factor: 1, aliases, plural, ...flags });

const UNIT_DEFINITIONS: UnitDefinition[] = [
  { code: 'fl oz', family: 'volume-us', factor: 6, aliases: ['fluid ounces', 'fluid ounce', 'fl. oz.', 'fl. oz', 'fl oz', 'fl.oz'] },
  { code: 'tbsp', family: 'volume-us', factor: 3, aliases: ['tablespoons', 'tablespoon', 'tbsps', 'tbsp', 'tbs', 'tbl', 'tblsp', 'T'] },
  { code: 'tsp', family: 'volume-us', factor: 1, aliases: ['teaspoons', 'teaspoon', 'tspns', 'tspn', 'tsps', 'tsp', 't'] },
  { code: 'cup', family: 'volume-us', factor: 48, aliases: ['cups', 'cup', 'c'], plural: 'cups' },
  { code: 'pint', family: 'volume-us', factor: 96, aliases: ['pints', 'pint', 'pt'], plural: 'pints' },
  { code: 'quart', family: 'volume-us', factor: 192, aliases: ['quarts', 'quart', 'qt'], plural: 'quarts' },
  { code: 'gallon', family: 'volume-us', factor: 768, aliases: ['gallons', 'gallon', 'gal'], plural: 'gallons' },
  { code: 'lb', family: 'mass-us', factor: 16, aliases: ['pounds', 'pound', 'lbs', 'lb'] },
  { code: 'oz', family: 'mass-us', factor: 1, aliases: ['ounces', 'ounce', 'oz'] },
  { code: 'kg', family: 'mass-metric', factor: 1000, aliases: ['kilograms', 'kilogram', 'kilos', 'kilo', 'kgs', 'kg'] },
  { code: 'g', family: 'mass-metric', factor: 1, aliases: ['grams', 'gram', 'gr', 'g'] },
  { code: 'l', family: 'volume-metric', factor: 1000, aliases: ['litres', 'litre', 'liters', 'liter', 'l'] },
  { code: 'cl', family: 'volume-metric', factor: 10, aliases: ['centilitres', 'centilitre', 'centiliters', 'centiliter', 'cl'] },
  { code: 'ml', family: 'volume-metric', factor: 1, aliases: ['millilitres', 'millilitre', 'milliliters', 'milliliter', 'ml'] },
  { code: 'dozen', family: 'count', factor: 12, aliases: ['dozens', 'dozen'] },
  { code: 'each', family: 'count', factor: 1, aliases: ['each', 'count'] },
  opaque('clove', 'cloves', ['cloves', 'clove']),
  opaque('can', 'cans', ['cans', 'can', 'tins', 'tin', 'tinned'], { container: true }),
  opaque('jar', 'jars', ['jars', 'jar'], { container: true }),
  opaque('package', 'packages', ['packages', 'package', 'pkgs', 'pkg', 'packets', 'packet', 'packs', 'pack', 'envelopes', 'envelope', 'pouches', 'pouch'], { container: true }),
  opaque('bunch', 'bunches', ['bunches', 'bunch']),
  opaque('slice', 'slices', ['slices', 'slice']),
  opaque('stick', 'sticks', ['sticks', 'stick']),
  opaque('head', 'heads', ['heads', 'head']),
  opaque('stalk', 'stalks', ['stalks', 'stalk']),
  opaque('sprig', 'sprigs', ['sprigs', 'sprig'], { approximate: true }),
  opaque('leaf', 'leaves', ['leaves', 'leaf']),
  opaque('piece', 'pieces', ['pieces', 'piece', 'pcs', 'pc']),
  opaque('fillet', 'fillets', ['fillets', 'fillet', 'filets', 'filet']),
  opaque('ear', 'ears', ['ears', 'ear']),
  opaque('rib', 'ribs', ['ribs', 'rib']),
  opaque('wedge', 'wedges', ['wedges', 'wedge']),
  opaque('sheet', 'sheets', ['sheets', 'sheet']),
  opaque('bottle', 'bottles', ['bottles', 'bottle'], { container: true }),
  opaque('bag', 'bags', ['bags', 'bag'], { container: true }),
  opaque('box', 'boxes', ['boxes', 'box'], { container: true }),
  opaque('container', 'containers', ['containers', 'container', 'tubs', 'tub'], { container: true }),
  opaque('carton', 'cartons', ['cartons', 'carton'], { container: true }),
  opaque('splash', 'splashes', ['splashes', 'splash'], { approximate: true }),
  opaque('pinch', 'pinches', ['pinches', 'pinch'], { approximate: true }),
  opaque('dash', 'dashes', ['dashes', 'dash'], { approximate: true }),
  opaque('drizzle', 'drizzles', ['drizzles', 'drizzle'], { approximate: true }),
  opaque('knob', 'knobs', ['knobs', 'knob'], { approximate: true }),
  opaque('squeeze', 'squeezes', ['squeezes', 'squeeze'], { approximate: true }),
  opaque('glug', 'glugs', ['glugs', 'glug'], { approximate: true }),
  opaque('sprinkle', 'sprinkles', ['sprinkles', 'sprinkle'], { approximate: true }),
  opaque('handful', 'handfuls', ['handfuls', 'handful'], { approximate: true }),
];

/** Single letters whose meaning depends on case: T is a tablespoon, t a teaspoon. Everything else matches case-insensitively. */
const CASE_SENSITIVE_ALIASES = new Set(['T', 't']);

const UNIT_ALIASES = UNIT_DEFINITIONS
  .flatMap((definition) => definition.aliases.map((alias) => ({ definition, alias })))
  .sort((a, b) => b.alias.length - a.alias.length);

/** A unit alias that is really the start of a product name: "rib eye steak" is not a rib of anything. */
const NOT_A_UNIT_BEFORE: Record<string, RegExp> = { rib: /^eyes?\b/i };

const CONTAINER_UNITS = UNIT_DEFINITIONS.filter((definition) => definition.container);
const CONTAINER_ALIAS = CONTAINER_UNITS.flatMap((definition) => definition.aliases).sort((a, b) => b.length - a.length).join('|');
/** Container words that follow a weight ("400g tin tomatoes"): the weight stays the measure, the container becomes a note. */
const CONTAINER_WORDS = new RegExp(`^(${CONTAINER_ALIAS})\\s+(?:of\\s+)?(.+)$`, 'i');
/** A size between the count and the container ("1 15 oz can black beans", "2 400g tins tomatoes") is a note. */
const CONTAINER_SIZE = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*-?\\s*(fl\\.? ?oz|oz|ounces?|grams?|gr|g|ml|lbs?|pounds?|kg|cl|l)\\.?\\s+(?=(?:${CONTAINER_ALIAS})\\b)`, 'i');

const WORD_QUANTITIES: Array<[RegExp, Rational, boolean]> = [
  [/^a couple(?: of)?\b/i, { numerator: 2, denominator: 1 }, true],
  [/^couple(?: of)?\b/i, { numerator: 2, denominator: 1 }, true],
  [/^a few\b/i, { numerator: 3, denominator: 1 }, true],
  [/^few\b/i, { numerator: 3, denominator: 1 }, true],
  [/^half (?:a|an|of a|of an)\b/i, { numerator: 1, denominator: 2 }, false],
  [/^half\b/i, { numerator: 1, denominator: 2 }, false],
  [/^(?:a|an|one)\b/i, { numerator: 1, denominator: 1 }, false],
  [/^two\b/i, { numerator: 2, denominator: 1 }, false],
  [/^three\b/i, { numerator: 3, denominator: 1 }, false],
  [/^four\b/i, { numerator: 4, denominator: 1 }, false],
  [/^five\b/i, { numerator: 5, denominator: 1 }, false],
  [/^six\b/i, { numerator: 6, denominator: 1 }, false],
  [/^seven\b/i, { numerator: 7, denominator: 1 }, false],
  [/^eight\b/i, { numerator: 8, denominator: 1 }, false],
  [/^nine\b/i, { numerator: 9, denominator: 1 }, false],
  [/^ten\b/i, { numerator: 10, denominator: 1 }, false],
  [/^eleven\b/i, { numerator: 11, denominator: 1 }, false],
  [/^twelve\b/i, { numerator: 12, denominator: 1 }, false],
];

/** Words that are never singularized (uncountable, or the plural is the product name). */
const PLURAL_EXCEPTIONS = new Set([
  'hummus', 'couscous', 'molasses', 'asparagus', 'swiss', 'chips', 'oats', 'grits', 'greens', 'lentils',
  'peas', 'beans', 'noodles', 'sprouts', 'seeds', 'nuts', 'flakes', 'chickpeas', 'chives', 'breadcrumbs',
  'crumbs', 'grains', 'citrus', 'bass', 'cress', 'watercress', 'pasta', 'brussels', 'succotash',
  'edamame', 'anise', 'hominy', 'tortellini', 'ravioli', 'gnocchi', 'crisps', 'cornflakes', 'pulses',
]);

const IRREGULAR_PLURALS: Record<string, string> = {
  leaves: 'leaf', loaves: 'loaf', halves: 'half', tomatoes: 'tomato', potatoes: 'potato', mangoes: 'mango',
};

/** Rewrites applied to the whole lowercase name before and after singularization. */
const SYNONYM_RULES: Array<[RegExp, string]> = [
  [/\b(?:scallions?|spring onions?|green onions?|salad onions?)\b/g, 'green onion'],
  [/\b(?:fresh coriander|coriander leaves|coriander leaf|cilantro leaves)\b/g, 'cilantro'],
  [/\b(?:confectioners'?|confectioner'?s|icing|powdered) sugar\b/g, 'powdered sugar'],
  [/\bgarbanzo beans?\b|\bgarbanzos?\b/g, 'chickpeas'],
  [/\baubergines?\b/g, 'eggplant'],
  [/\bcourgettes?\b/g, 'zucchini'],
  [/\bcapsicums?\b/g, 'bell pepper'],
  // A bare plural "peppers" means bell peppers; the singular "pepper" is the spice.
  [/^(?:sweet |mixed |fresh )?peppers$/g, 'bell pepper'],
  [/\byoghurt\b/g, 'yogurt'],
  [/\bmayo\b/g, 'mayonnaise'],
  [/\bevoo\b|\bextra[- ]virgin olive oil\b/g, 'extra virgin olive oil'],
  [/\bspray oil\b|\boil spray\b|\bnon-?stick spray\b/g, 'cooking spray'],
  [/\bgarlic cloves?\b|\bcloves? of garlic\b|\bcloves? garlic\b/g, 'garlic'],
  [/\bbicarbonate of soda\b|\bbicarb(?:onate)?\b/g, 'baking soda'],
  [/\bcastor sugar\b|\bsuperfine sugar\b/g, 'caster sugar'],
  [/\bplain flour\b|\ball[- ]purpose flour\b|\bap flour\b/g, 'all-purpose flour'],
  [/\bcorn ?starch\b|\bcornflour\b|\bcorn flour\b/g, 'cornstarch'],
  [/\bchilli\b/g, 'chili'],
  [/\b(?:chillies|chilies|chiles|chillis|chilis)\b/g, 'chili'],
];

/**
 * Preparation words. After a comma they always start a preparation clause ("garlic, crushed").
 * Only LEADING_PREPARATION words are also stripped from the front of a name: "crushed tomatoes",
 * "ground beef", "dried oregano", "roasted red peppers" are product names and keep their first word.
 */
const PREPARATION_WORDS = [
  'finely chopped', 'roughly chopped', 'thinly sliced', 'coarsely chopped', 'coarsely ground', 'lightly beaten',
  'cut into', 'at room temperature', 'room temperature', 'diced', 'minced', 'chopped', 'sliced', 'grated',
  'shredded', 'divided', 'melted', 'softened', 'drained', 'rinsed', 'peeled', 'crushed', 'zested', 'juiced',
  'cubed', 'halved', 'quartered', 'torn', 'crumbled', 'beaten', 'toasted', 'sifted', 'deveined', 'trimmed',
  'pitted', 'seeded', 'deseeded', 'cored', 'mashed', 'pressed', 'smashed', 'thawed', 'defrosted', 'cooked',
  'uncooked', 'julienned', 'chilled', 'warmed', 'boiled', 'hard-boiled', 'hard boiled', 'soft-boiled',
  'separated', 'whisked', 'stemmed', 'destemmed', 'shelled', 'hulled', 'scrubbed', 'washed', 'patted dry',
  'cut in half', 'cut into chunks', 'cut into cubes', 'bruised', 'roasted', 'ground', 'skin on', 'skin removed',
  'bones removed', 'seeds removed', 'seeds and ribs removed', 'ribs and seeds removed', 'stems removed', 'stem removed',
  'tough stems removed', 'ends trimmed', 'woody ends removed', 'tails removed', 'shells removed', 'leaves and stems',
  'stems and leaves', 'leaves only', 'leaves picked', 'leaves stripped',
];

/** A clause that ends in a participle is a preparation even when it starts with a noun: "seeds removed", "tails discarded". */
const TRAILING_PARTICIPLE_CLAUSE = /\b(?:removed|discarded|reserved|trimmed|picked|stripped|chopped|sliced|minced|diced|separated|torn|crushed|grated|peeled|halved|quartered|cubed|shredded|drained|rinsed|thawed|softened|melted|beaten|divided|set aside)$/i;

const PREPARATION_ADVERBS = ['very', 'finely', 'roughly', 'thinly', 'coarsely', 'lightly', 'freshly', 'well', 'thickly'];

const LEADING_PREPARATION = new Set([
  'chopped', 'diced', 'minced', 'sliced', 'grated', 'shredded', 'cubed', 'halved', 'quartered', 'torn',
  'crumbled', 'beaten', 'softened', 'melted', 'sifted', 'drained', 'rinsed', 'deveined', 'trimmed', 'pitted',
  'seeded', 'deseeded', 'cored', 'zested', 'juiced', 'mashed', 'pressed', 'smashed', 'thawed', 'defrosted',
  'cooked', 'uncooked', 'peeled', 'julienned', 'chilled', 'warmed', 'boiled', 'hard-boiled', 'soft-boiled',
  'separated', 'whisked', 'stemmed', 'shelled', 'hulled', 'scrubbed', 'washed',
]);

/** Phrases that mean the cook decides the amount. Removed from the name, kept in rawText. */
const COOK_DECIDES = /(?:,\s*|\s+|^)(?:or more to taste|or to taste|to taste|as needed|if needed|as required|if required|or as needed|for serving|for the table|for garnish|for garnishing|to garnish|to serve|for greasing|for frying|for shallow frying|for deep frying|for the pan|for drizzling|for brushing|for dusting|for sprinkling|for topping|for cooking|for sauteing|for sautéing|for roasting|for coating|for dredging|for rolling|to loosen|to thin|to deglaze|to finish|plus (?:more|extra)(?:\s+(?:for|to|as)\b.*)?|and (?:more|extra) for\b.*)\s*(?=,|$)/i;

const SIZE_DESCRIPTORS = /^(small|medium|large|extra[- ]large|jumbo)\s+(?!or\b)(.+)$/i;

/**
 * Single words that only qualify the noun after "or": "fresh or frozen corn", "red or yellow bell pepper",
 * "chicken or vegetable broth". The noun is shared, so the name becomes "fresh corn" with the alternative as a note.
 */
const SHARED_HEAD_QUALIFIERS = new Set([
  'fresh', 'frozen', 'dried', 'canned', 'tinned', 'jarred', 'raw', 'cooked', 'red', 'yellow', 'green', 'orange', 'white',
  'black', 'brown', 'purple', 'sweet', 'hot', 'mild', 'spicy', 'small', 'medium', 'large', 'baby', 'whole', 'skim',
  'low-fat', 'lowfat', 'full-fat', 'light', 'dark', 'regular', 'plain', 'unsalted', 'salted', 'smooth', 'crunchy', 'chunky',
  'oat', 'almond', 'soy', 'coconut', 'cashew', 'rice', 'chicken', 'beef', 'vegetable', 'veggie', 'turkey', 'pork', 'lamb',
  'fish', 'bone', 'russet', 'yukon', 'roma', 'cherry', 'grape', 'flat-leaf', 'curly', 'thai', 'italian', 'greek', 'kosher',
  'sea', 'table', 'fine', 'coarse', 'virgin', 'extra-virgin', 'toasted', 'roasted', 'smoked', 'ground', 'crushed', 'granulated',
  'powdered', 'caster', 'maple', 'golden', 'corn', 'cane', 'vanilla', 'wild', 'farmed', 'boneless', 'skinless', 'bone-in',
  'skin-on', 'lean', 'ripe', 'firm', 'soft', 'crusty', 'stale', 'day-old', 'sourdough', 'wholemeal', 'whole-wheat',
  'self-raising', 'self-rising', 'all-purpose', 'bread', 'cake', 'instant', 'quick', 'rolled', 'steel-cut', 'long-grain',
  'short-grain', 'basmati', 'jasmine', 'arborio', 'lemon', 'lime', 'red-wine', 'white-wine', 'balsamic', 'cider',
]);

/** Water and ice never go on the list. Flavored waters (coconut, rose, sparkling) are real purchases and stay. */
const SKIP_GROCERY = /^(?:(?:warm|hot|cold|boiling|boiled|lukewarm|tap|filtered|iced|ice|ice-cold|room[- ]temperature|cool|tepid|very hot|fresh|plain|extra)\s+)*(?:water|ice(?:\s+cubes?)?|crushed ice|cubes? of ice)(?:\s+(?:to|for|as|if)\b.*)?$/i;

/**
 * Ordered aisle rules. The first match wins, so compound products ("red pepper flakes", "butter lettuce",
 * "egg noodles", "coconut milk") are listed before the generic word that would otherwise claim them.
 * The parser prefixes hint words such as "canned" when the unit was a can or jar.
 */
const CATEGORY_RULES: Array<[GroceryCategory, RegExp]> = [
  // Frozen aisle first: "frozen peas" must never fall through to Produce.
  ['Frozen', /\bfrozen\b|\bice cream\b|\bpuff pastry\b|\b(?:phyllo|filo)\b|\bpopsicles?\b|\bice loll(?:y|ies)\b/],

  // Spice-rack items that contain a produce, dairy or meat word.
  ['Spices & Seasonings', /\b(?:red |chil[ie] |chili |aleppo )?pepper flakes\b|\bcrushed red pepper\b|\bchil[ie] flakes\b|\bchili flakes\b/],
  ['Spices & Seasonings', /\b(?:black|white|cayenne|ground|cracked|lemon|sichuan|szechuan|pink|mixed) pepper(?:corns?)?\b|\bpeppercorns?\b/],
  ['Spices & Seasonings', /^(?:(?:freshly|fresh|ground|cracked|coarsely|coarse|finely|fine|black)\s+)*pepper$/],
  ['Spices & Seasonings', /\b(?:garlic|onion|chil[ie]|chili|curry|five[- ]spice|mustard|ginger|chipotle|ancho|wasabi|cayenne) powder\b/],
  ['Spices & Seasonings', /\bdried (?:oregano|thyme|basil|parsley|rosemary|dill|mint|chives|cilantro|sage|tarragon|marjoram|herbs?|chil(?:i|ies)|lavender|bay lea(?:f|ves)|onion|garlic|minced onion)\b/],
  ['Spices & Seasonings', /\b(?:garlic|celery|onion|seasoned|seasoning|truffle|smoked|lemon|chili|chil[ie]) salt\b|\bonion soup mix\b|\bsoup mix\b/],
  ['Spices & Seasonings', /\bground (?:ginger|cumin|coriander|cinnamon|nutmeg|cloves|allspice|cardamom|turmeric|mustard|fennel|sumac|chili|chil[ie]|paprika|sage|thyme|oregano|cayenne|black pepper|white pepper)\b/],
  ['Spices & Seasonings', /\b(?:bouillon|stock cubes?|stock pots?|stock powder|broth powder|better than bouillon)\b/],
  ['Spices & Seasonings', /\b(?:mustard|fennel|celery|coriander|cumin|caraway|nigella|fenugreek|poppy|anise) seeds?\b/],
  // Dried, ground or granulated forms of produce words are spice-rack items: "garlic granules", "dried mixed herbs", "ground ginger".
  ['Spices & Seasonings', /\b(?:garlic|onion|ginger|shallot|chil[ie]|chili|jalape[ñn]o|chipotle|wasabi|horseradish|mustard|celery|tomato|mushroom|lemon|lime|orange) (?:granules?|granulated|powder|powdered|flakes?|salt)\b/],
  ['Spices & Seasonings', /\b(?:dried|dry|ground|granulated|powdered|dehydrated|rubbed) (?:\w+ )?(?:garlic|onion|ginger|shallot|herbs?|basil|oregano|thyme|parsley|rosemary|dill|mint|chives|cilantro|coriander|sage|tarragon|marjoram|lemongrass|turmeric|chil(?:i|ies|e|es)|bay lea(?:f|ves)|lemon peel|orange peel|lemon zest|orange zest)\b/],
  // "fresh mixed herbs" is a produce bunch, not a dried blend.
  ['Spices & Seasonings', /(?<!\bfresh )\b(?:mixed|italian|dried|mediterranean|proven[cç]al|greek|tuscan|french|fines|herb) herbs?\b|\bherb(?:e)?s de provence\b|\bbouquet garni\b/],

  // Produce items that contain a dairy, spice, grain or meat word.
  ['Produce', /\bbutter lettuce\b|\boyster mushrooms?\b|\bmustard greens\b|\bswiss chard\b|\bchard\b|\bfresh (?:oregano|thyme|basil|parsley|rosemary|dill|mint|chives|cilantro|sage|tarragon|marjoram|herbs?|bay lea(?:f|ves)|ginger|turmeric|chil(?:i|ies|e|es))\b|\bsugar snap peas\b|\bbeefsteak tomato(?:es)?\b|\bcoconut (?:water|meat)\b|\bcelery (?:ribs?|stalks?|hearts?)\b|\b(?:ribs?|stalks?) of celery\b|\bcauliflower rice\b|\briced cauliflower\b|\bzucchini noodles?\b|\bzoodles\b|\blettuce (?:wraps?|lea(?:f|ves)|cups?)\b/],
  ['Produce', /\b(?:lemon|lime|orange) (?:juice|zest|wedges?|slices?)\b|\bjuice of\b|\bzest of\b/],

  // Generic spice rack.
  ['Spices & Seasonings', /\b(?:salt|kosher salt|sea salt|table salt|flaky salt|fleur de sel|maldon|cumin|paprika|smoked paprika|turmeric|coriander|cinnamon|nutmeg|cloves?|cardamom|allspice|star anise|saffron|sumac|za'?atar|oregano|marjoram|seasoning|garam masala|curry powder|chili powder|cayenne|chipotle powder|italian seasoning|taco seasoning|herbes de provence|old bay|cajun|creole seasoning|poultry seasoning|pumpkin pie spice|apple pie spice|mixed spice|five spice|ras el hanout|baharat|berbere|dukkah|shichimi|togarashi|furikake|gochugaru|aleppo pepper|urfa|ancho|guajillo|dried chil(?:i|ies)|bay lea(?:f|ves)|juniper berr(?:y|ies)|mace|asafoetida|hing|amchur|kasuri methi|dried fenugreek|peppercorns?|white pepper|black pepper|msg|spice blend|spices?|dry rub|seasoning blend|onion flakes|garlic flakes|dried parsley|dried basil|dried dill|dried mint|dried thyme|dried rosemary|dried oregano|dried sage|dried tarragon|dried chives|dried cilantro|cinnamon sticks?|celery seed|caraway|fennel seed|mustard seed|nigella)\b/],

  // Pantry items that contain a dairy, produce or bakery word.
  ['Pantry', /\b(?:peanut|almond|cashew|sunflower|nut|cocoa|apple|seed|hazelnut|pistachio|biscoff|cookie) butter\b|\bcream of tartar\b|\bbreadcrumbs?\b|\bbread crumbs?\b|\bpanko\b|\bbread flour\b|\brice flour\b|\brice paper\b|\btortilla chips\b|\bpotato chips\b|\bcorn ?starch\b|\bcornmeal\b|\bcorn ?flour\b|\bcorn syrup\b|\bpopcorn\b|\b(?:lemon|almond|vanilla|peppermint|orange|coconut|mint) extract\b|\bextracts?\b|\bmilk chocolate\b|\bwhite chocolate\b|\bcoconut flakes\b|\bshredded coconut\b|\bdesiccated coconut\b|\bcoconut flour\b|\bcoconut sugar\b|\b(?:pumpkin|sunflower|chia|flax|sesame|hemp|poppy) seeds?\b|\bpepitas?\b|\bflaxseed\b|\bdried (?:porcini|shiitake|mushrooms?)\b|\b(?:egg roll|wonton|dumpling|spring roll|gyoza) wrappers?\b|\b(?:pancake|cake|brownie|baking|muffin) mix\b|\bbisquick\b|\bchestnuts?\b/],
  ['Pantry', /\bdried (?:cranberr(?:y|ies)|apricots?|cherr(?:y|ies)|figs?|mango(?:es)?|fruits?|blueberr(?:y|ies)|dates?|currants?)\b|\b(?:raisins?|sultanas?|dates?|prunes?|currants?|dried fruit)\b/],
  ['Pantry', /\b(?:chocolate|cacao) (?:chips|chunks?|bars?)\b|\bchocolate\b|\bcocoa\b|\bcacao\b/],

  // Dairy items that contain a produce or bakery word.
  ['Dairy & Eggs', /\b(?:almond|oat|soy|soya|cashew|rice|hemp|pea|macadamia|plant) milk\b|\bpepper jack\b|\bnon-?dairy milk\b|\bghee\b/],

  // Pasta aisle items that contain a dairy word, and dried pulses (canned ones are matched later).
  ['Pasta, Rice & Grains', /\begg noodles?\b|\bdried (?:beans|lentils|chickpeas|peas|black beans|kidney beans|pinto beans|split peas|white beans|cannellini beans|navy beans|lima beans|black-eyed peas)\b/],

  // Fresh fish that shares a word with a canned product.
  ['Meat & Seafood', /\btuna steaks?\b|\bfresh tuna\b|\bahi tuna\b|\bsushi[- ]grade tuna\b|\bfresh salmon\b|\bsalmon fillets?\b/],

  // Sauces that contain a produce, grain or meat word.
  ['Sauces & Condiments', /\b(?:rice|rice wine|white wine|red wine|apple cider|cider|balsamic|sherry|malt|champagne|distilled|white) vinegar\b|\bvinegar\b|\bmirin\b|\bcooking wine\b|\brice wine\b|\bshaoxing\b|\bshrimp paste\b|\b(?:fish|oyster|hoisin|soy|hot|worcestershire|bbq|barbecue|teriyaki|ponzu|chili garlic|chili|sweet chili|peanut|tartar|steak|buffalo|cocktail|duck|plum|black bean|xo|sriracha|tabasco|enchilada|adobo|taco|alfredo|cheese|cranberry) sauce\b/],
  ['Sauces & Condiments', /\b(?:olive|vegetable|canola|rapeseed|sunflower|coconut|sesame|avocado|peanut|grapeseed|corn|safflower|truffle|chili|chilli|neutral|cooking|frying|spray|toasted sesame) oil\b|\bcooking spray\b|\bspray oil\b|\boil\b(?!-packed)/],

  // Canned & jarred, including items that also contain produce words.
  ['Canned & Jarred', /\b(?:canned|tinned|jarred|tin of|can of|jar of)\b|\bsun-?dried tomato(?:es)?\b|\broasted red peppers?\b|\bartichoke hearts?\b|\bhearts of palm\b|\bwater chestnuts?\b|\bbamboo shoots?\b|\bpickled\b|\bpickles?\b|\bcapers?\b|\bolives\b|\bolive\b(?! oil)|\bchipotles? in adobo\b|\badobo\b|\bsauerkraut\b|\bkimchi\b|\bpimentos?\b|\bpimientos?\b|\bclam juice\b/],
  ['Canned & Jarred', /\b(?:tomato (?:paste|puree|purée|sauce)|passata|crushed tomato(?:es)?|diced tomato(?:es)?|chopped tomato(?:es)?|whole peeled tomato(?:es)?|peeled tomato(?:es)?|fire[- ]roasted tomato(?:es)?|stewed tomato(?:es)?|san marzano|pizza sauce|pasta sauce|marinara|salsa|salsa verde|pesto|tomato soup|cream of (?:mushroom|chicken|celery|tomato|asparagus) soup|condensed soup|pumpkin puree|pumpkin purée|pumpkin pie filling|pie filling|applesauce|apple sauce|cranberry sauce|creamed corn|cream corn|refried beans|baked beans)\b/],
  ['Canned & Jarred', /\b(?:chicken|beef|vegetable|veggie|bone|fish|seafood|turkey|mushroom|ham|pork|lamb|dashi|miso) (?:broth|stock)\b|\b(?:broth|stock)\b|\bcoconut (?:milk|cream)\b|\b(?:evaporated|condensed|sweetened condensed) milk\b|\bdulce de leche\b/],
  ['Canned & Jarred', /\bchickpeas?\b|\bgarbanzo\b|\b(?:black|kidney|cannellini|pinto|navy|white|great northern|butter|lima|red|borlotti|fava|mixed|black-eyed) (?:beans|peas)\b|\bcanned beans\b|\btuna\b|\bsardines?\b|\banchov(?:y|ies)\b|\banchovy paste\b|\bjackfruit\b|\bcorn kernels\b|\bgreen chil(?:ies|es) in\b|\bdiced green chil(?:ies|es)\b/],

  // Remaining sauces and condiments.
  ['Sauces & Condiments', /\b(?:soy sauce|tamari|coconut aminos|liquid aminos|ketchup|catsup|mustard|mayonnaise|mayo|aioli|relish|chutney|harissa|gochujang|miso|curry paste|tahini sauce|sriracha|hot sauce|tabasco|hoisin|worcestershire|bbq|barbecue|salad dressing|dressing|vinaigrette|ranch|tzatziki|hummus|guacamole|horseradish|wasabi|chili crisp|chili oil|sambal|sambal oelek|ponzu|teriyaki|sauce|marinade|glaze|honey mustard|nam pla|doenjang|ssamjang|tamarind paste|tamarind concentrate|liquid smoke)\b/],

  // Pasta, rice and grains.
  ['Pasta, Rice & Grains', /\b(?:rice|basmati|jasmine|arborio|carnaroli|risotto|quinoa|pasta|spaghetti|penne|rigatoni|orzo|macaroni|fettuccine|fettuccini|linguine|linguini|fusilli|farfalle|rotini|ziti|cavatappi|bucatini|tagliatelle|pappardelle|angel hair|capellini|vermicelli|shells?|conchiglie|gemelli|lasagna|lasagne|gnocchi|tortellini|ravioli|noodles?|ramen|udon|soba|couscous|farro|barley|bulgur|bulgar|polenta|grits|oats|oatmeal|millet|freekeh|spelt|buckwheat|wheat berr(?:y|ies)|lentils?|split peas|dried beans|dal|dahl|daal|moong|urad|masoor)\b/],

  // Bakery.
  ['Bakery', /\b(?:tortillas?|pita|pitta|naan|bagels?|baguettes?|bread|buns?|rolls?|croissants?|ciabatta|sourdough|focaccia|brioche|english muffins?|wraps?|flatbreads?|crumpets?|loaf|loaves|croutons?|pizza dough|pizza crust|pie crust|pie shell|pastry|crust|taco shells?|tostadas?|lavash|challah|rye|pumpernickel|biscuits?|scones?|muffins?|cake|cupcakes?|ladyfingers?)\b/],

  // Dairy and eggs.
  ['Dairy & Eggs', /\b(?:milk|cream|half and half|half-and-half|butter|buttermilk|cheese|cheddar|mozzarella|parmesan|parmigiano|parmigiano-reggiano|pecorino|romano|feta|goat cheese|chevre|chèvre|ricotta|brie|camembert|gouda|gruyere|gruyère|swiss|provolone|monterey jack|jack cheese|colby|cotija|queso|queso fresco|halloumi|paneer|mascarpone|burrata|yogurt|yoghurt|sour cream|creme fraiche|crème fraîche|eggs?|egg whites?|egg yolks?|cottage cheese|kefir|labneh|cream cheese|neufchatel|velveeta|american cheese|blue cheese|gorgonzola|stilton|asiago|fontina|havarti|manchego|emmental|boursin|string cheese|quark|skyr)\b/],

  // Meat and seafood.
  ['Meat & Seafood', /\b(?:chicken|beef|steak|mince|pork|bacon|pancetta|ham|prosciutto|sausages?|chorizo|salami|pepperoni|lamb|turkey|duck|veal|venison|bison|brisket|ribs?|short ribs?|tenderloin|sirloin|ribeye|rib-eye|flank|skirt steak|chuck|roast|meatballs?|hot dogs?|frankfurters?|bratwurst|kielbasa|salmon|cod|haddock|halibut|tilapia|trout|ahi|mahi|snapper|sea bass|bass|swordfish|mackerel|shrimp|prawns?|scallops?|crab|crabmeat|lobster|mussels?|clams?|oysters?|squid|calamari|octopus|fish|seafood|wings?|drumsticks?|thighs?|breasts?|cutlets?|loin|shoulder|belly|shank|liver|oxtail|guanciale|lardons|speck|bresaola|mortadella|capicola|deli meat|lunch meat|cold cuts?)\b/],

  // Produce.
  ['Produce', /\b(?:peppers?|jalape[ñn]os?|poblanos?|serranos?|habaneros?|chil(?:i|ies|e|es)|shishito|padron|anaheim|fresno|onions?|shallots?|leeks?|garlic|ginger|galangal|lemongrass|turmeric root|lemons?|limes?|oranges?|grapefruits?|clementines?|mandarins?|tangerines?|apples?|pears?|bananas?|plantains?|(?:straw|blue|rasp|black|cran|goose|mul|boysen)?berr(?:y|ies)|cherr(?:y|ies)|grapes?|melon|watermelon|cantaloupe|honeydew|pineapple|mango(?:es)?|papaya|kiwi|peach(?:es)?|plums?|nectarines?|apricots?|figs?|pomegranate|avocados?|tomato(?:es)?|tomatillos?|cucumbers?|lettuce|romaine|iceberg|arugula|rocket|spinach|kale|collards?|collard greens|cabbage|bok choy|pak choi|brussels sprouts|broccoli|broccolini|cauliflower|carrots?|celery|celeriac|parsnips?|turnips?|rutabaga|radish(?:es)?|daikon|beets?|beetroot|potato(?:es)?|sweet potato(?:es)?|yams?|zucchini|courgettes?|squash|butternut|pumpkin|eggplant|aubergine|mushrooms?|cremini|shiitake|portobello|portabella|asparagus|green beans|string beans|snap peas|snow peas|peas|edamame|corn|sweetcorn|fennel|artichokes?|okra|endive|radicchio|watercress|microgreens|sprouts|bean sprouts|alfalfa|herbs?|basil|parsley|cilantro|dill|mint|rosemary|thyme|chives|sage|tarragon|marjoram|green onions?|scallions?|spring onions?|salad greens|mixed greens|spring mix|baby greens|tofu|tempeh|seitan|jicama|kohlrabi|chayote|nopales|cassava|yuca|taro|rhubarb|avocado)\b/],

  // Pantry.
  ['Pantry', /\b(?:flour|tapioca|arrowroot|sugar|honey|maple syrup|syrup|golden syrup|agave|molasses|treacle|baking powder|baking soda|yeast|cornstarch|vanilla|vanilla extract|extract|almonds?|walnuts?|pecans?|cashews?|peanuts?|pistachios?|hazelnuts?|macadamias?|pine nuts|nuts|mixed nuts|seeds|crackers?|graham crackers|chips|pretzels?|granola|cereal|peanut butter|almond butter|tahini|nutella|jam|jelly|preserves|marmalade|gelatin|gelatine|agar|pectin|protein powder|collagen|coconut|nutritional yeast|stuffing|instant coffee|espresso powder|coffee|tea|matcha|sprinkles?|food coloring|marshmallows?|caramel|wafers?|cookies?|oreos?|trail mix|rice cakes|seaweed|nori|wakame|kombu|bonito|dashi powder|xanthan gum|baking chocolate|toffee bits|butterscotch chips|candy|wine|sherry|vermouth|beer|rum|bourbon|whiskey|brandy|vodka|tequila|sake|liqueur|cider)\b/],
];

const DISPLAY_FRACTIONS: Record<string, string> = {
  '1/8': '⅛', '1/6': '⅙', '1/5': '⅕', '1/4': '¼', '1/3': '⅓', '3/8': '⅜', '2/5': '⅖', '1/2': '½',
  '3/5': '⅗', '5/8': '⅝', '2/3': '⅔', '3/4': '¾', '4/5': '⅘', '5/6': '⅚', '7/8': '⅞',
};

export function makeId(prefix = 'id'): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

export function rational(numerator: number, denominator = 1): Rational {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    throw new Error('Invalid quantity');
  }
  const sign = denominator < 0 ? -1 : 1;
  const divisor = gcd(numerator, denominator);
  return { numerator: (numerator / divisor) * sign, denominator: Math.abs(denominator / divisor) };
}

export function addRational(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
}

export function multiplyRational(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.numerator, a.denominator * b.denominator);
}

export function divideRational(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator, a.denominator * b.numerator);
}

/** "1½", "1 1/6", "-½": a glyph is glued to the whole number, a fraction without a glyph gets a space, the sign survives. */
export function formatRational(value: Rational | null): string {
  if (!value) return '';
  const reduced = rational(value.numerator, value.denominator);
  const sign = reduced.numerator < 0 ? '-' : '';
  const magnitude = Math.abs(reduced.numerator);
  const whole = Math.floor(magnitude / reduced.denominator);
  const remainder = magnitude % reduced.denominator;
  if (!remainder) return `${sign}${whole}`;
  const glyph = DISPLAY_FRACTIONS[`${remainder}/${reduced.denominator}`];
  if (!whole) return `${sign}${glyph ?? `${remainder}/${reduced.denominator}`}`;
  return glyph ? `${sign}${whole}${glyph}` : `${sign}${whole} ${remainder}/${reduced.denominator}`;
}

/**
 * Grocery display: the amount rounded to the nearest eighth, or to the nearest third when that is closer, prefixed
 * with "≈" when rounding changed it. "7/12" becomes "≈⅝", "2¼" stays "2¼"; a trace amount rounds up to "≈⅛", never to 0.
 */
export function formatShoppingQuantity(value: Rational | null): string {
  if (!value) return '';
  const exact = value.numerator / value.denominator;
  const nearest = (denominator: number): Rational => rational(Math.round(exact * denominator), denominator);
  const candidates = [nearest(8), nearest(3)].map((candidate) => ({ candidate, error: Math.abs(candidate.numerator / candidate.denominator - exact) }));
  let best = candidates.reduce((winner, entry) => (entry.error < winner.error ? entry : winner)).candidate;
  if (best.numerator === 0 && exact > 0) best = rational(1, 8);
  if (best.numerator === 0 && exact < 0) best = rational(-1, 8);
  const rounded = best.numerator * value.denominator !== value.numerator * best.denominator;
  return `${rounded ? '≈' : ''}${formatRational(best)}`;
}

/** A decimal fraction such as 0.33 snaps to the fraction the author meant (⅓) when it is within 0.01 of one. */
function decimalFraction(fraction: number, places: number): Rational {
  const snapped = DECIMAL_SNAPS.find((candidate) => Math.abs(candidate.numerator / candidate.denominator - fraction) <= 0.01);
  return snapped ?? rational(Math.round(fraction * 10 ** places), 10 ** places);
}

export function parseRationalToken(value: string): Rational | null {
  const token = value.trim();
  if (!token) return null;
  const mixedAscii = token.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixedAscii) return addRational(rational(Number(mixedAscii[1])), rational(Number(mixedAscii[2]), Number(mixedAscii[3])));
  const simpleAscii = token.match(/^(\d+)\/(\d+)$/);
  if (simpleAscii && Number(simpleAscii[2]) !== 0) return rational(Number(simpleAscii[1]), Number(simpleAscii[2]));
  const mixedVulgar = token.match(MIXED_VULGAR_TOKEN);
  if (mixedVulgar) return addRational(rational(Number(mixedVulgar[1])), VULGAR_FRACTIONS[mixedVulgar[2]]);
  if (VULGAR_FRACTIONS[token]) return VULGAR_FRACTIONS[token];
  if (/^\d{1,3}(?:,\d{3})+$/.test(token)) return rational(Number(token.replace(/,/g, '')));
  const decimal = token.match(/^(\d*)[.,](\d+)$/);
  if (decimal) {
    const whole = rational(Number(decimal[1] || '0'));
    const fraction = Number(`0.${decimal[2]}`);
    return fraction ? addRational(whole, decimalFraction(fraction, decimal[2].length)) : whole;
  }
  if (/^\d+$/.test(token)) return rational(Number(token));
  return null;
}

function unitDefinition(code: string | null): UnitDefinition | null {
  return UNIT_DEFINITIONS.find((definition) => definition.code === code) ?? null;
}

function isMoreThanOne(quantity: Rational | number | null | undefined): boolean {
  if (quantity === null || quantity === undefined) return false;
  return typeof quantity === 'number' ? quantity > 1 : quantity.numerator > quantity.denominator;
}

/** "cup" → "cups" for amounts above one; invariant codes (tbsp, oz, g) never change; "each" displays as nothing. */
export function pluralizeUnit(unit: string | null, quantity: Rational | number | null = null): string {
  if (!unit || unit === 'each') return '';
  const definition = unitDefinition(unit);
  if (!definition) return unit;
  return isMoreThanOne(quantity) && definition.plural ? definition.plural : definition.code;
}

/** "7 cloves", "1½ lb", "2 cups", "2–3 cloves"; empty when there is no quantity. */
export function formatQuantityWithUnit(quantity: Rational | null, unit: string | null, quantityMax: Rational | null = null): string {
  if (!quantity) return '';
  const amount = quantityMax && quantityMax.numerator * quantity.denominator !== quantity.numerator * quantityMax.denominator
    ? `${formatRational(quantity)}–${formatRational(quantityMax)}`
    : formatRational(quantity);
  return [amount, pluralizeUnit(unit, quantityMax ?? quantity)].filter(Boolean).join(' ');
}

function singularizeWord(word: string): string {
  if (word.length <= 3 || PLURAL_EXCEPTIONS.has(word)) return word;
  if (IRREGULAR_PLURALS[word]) return IRREGULAR_PLURALS[word];
  if (/(?:ss|us|is)$/.test(word)) return word;
  if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:ch|sh|x|ss|z)es$/.test(word)) return word.slice(0, -2);
  if (/oes$/.test(word)) return word.slice(0, -2);
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

function applySynonyms(value: string): string {
  return SYNONYM_RULES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

export function normalizeIngredientName(value: string): string {
  const cleaned = asciiFractions(value)
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[“”"]/g, '')
    .replace(/[’`]/g, "'")
    .replace(/[,;:.!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const words = applySynonyms(cleaned).split(' ');
  words[words.length - 1] = singularizeWord(words[words.length - 1]);
  return applySynonyms(words.join(' ')).replace(/\s+/g, ' ').trim();
}

export function groceryCategoryFor(name: string): GroceryCategory {
  const text = name.normalize('NFKC').toLowerCase().replace(/\s*&\s*/g, ' and ').replace(/\s+/g, ' ').trim();
  return CATEGORY_RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? 'Other';
}

const STAPLE_QUALIFIERS = /^(?:fine|coarse|kosher|sea|flaky|table|iodized|freshly ground|freshly cracked|ground|cracked|extra virgin|extra-virgin|light|pure|regular|plain|unsalted|salted|good|quality|good quality|neutral)\s+/;

function stapleCore(value: string): string {
  let core = normalizeIngredientName(value);
  while (STAPLE_QUALIFIERS.test(core)) core = core.replace(STAPLE_QUALIFIERS, '');
  return core === 'pepper' ? 'black pepper' : core;
}

/**
 * True when the ingredient is one of the household's pantry staples: an exact match, a match once leading
 * qualifiers are removed ("fine sea salt" → "salt", "pepper" ↔ "black pepper"), or a composite such as
 * "salt and pepper" whose every part is a staple. "garlic salt" and "bell pepper" are their own products.
 */
export function matchesPantryStaple(normalizedIngredient: string, staples: string[]): boolean {
  if (!staples.length || !normalizedIngredient) return false;
  const cores = new Set(staples.map(stapleCore).filter(Boolean));
  const matchesOne = (part: string): boolean => {
    const normalized = normalizeIngredientName(part);
    return cores.has(normalized) || cores.has(stapleCore(normalized));
  };
  if (matchesOne(normalizedIngredient)) return true;
  const parts = normalizedIngredient.split(/\s*(?:,|\band\b|&)\s*/).map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 && parts.every(matchesOne);
}

const RANGE_PATTERN = new RegExp(`^(${NUMBER_TOKEN})\\s*(?:-|–|—|to|or)\\s*(${NUMBER_TOKEN})(?=\\s|$|[a-zA-Z])`, 'i');
const QUANTITY_PATTERN = new RegExp(`^(${NUMBER_TOKEN})(?=\\s|$|[a-zA-Z(])`);
/** "2-inch piece ginger": the size is a note, the piece is the unit. */
const SIZE_PREFIX = new RegExp(`^(${NUMBER_TOKEN})\\s*[-–]?\\s*(inch|inches|in|cm|")\\s+(?:of\\s+)?(.+)$`, 'i');
const MULTIPLIER_PATTERN = /^x\s*(\d+(?:\.\d+)?\s*(?:g|kg|ml|l|oz|lb|lbs|cl|grams?)\b\.?)\s*/i;
const APPROXIMATE_PREFIX = /^(?:about|approx\.?|approximately|roughly|around|~)\s+/i;
/** How full the measure is ("1 packed cup", "1 cup packed brown sugar", "1 heaping tbsp"): a note, never part of the name. */
const MEASURE_QUALIFIER = /^((?:firmly |lightly |loosely )?packed|heaping|heaped|generous|scant|level|rounded|good|healthy)\s+(.+)$/i;
/** A size word before the unit describes the measure and becomes the descriptor: "1 large bunch kale", "a small handful". */
const MEASURE_ADJECTIVE = /^(big|large|medium|small|little|extra[- ]large|jumbo)\s+(.+)$/i;
/** An alternate measure after the unit ("1 cup/240 ml milk") or an addition to it ("1 cup + 2 tbsp flour"). */
const ALTERNATE_MEASURE = new RegExp(`^\\/\\s*(${NUMBER_TOKEN})\\s*([a-zA-Z.]+)\\s+`);
const ADDED_MEASURE = new RegExp(`^\\+\\s*(${NUMBER_TOKEN})\\s*([a-zA-Z.]+)\\s+`);
const JUICE_OF = /^((?:(?:finely\s+)?grated\s+)?(?:zest and juice|juice and zest|juice|zest|grated zest)\s+(?:of|from))\s+(.+)$/i;
const BULLET_PREFIX = /^[\s\-–—•*▪◦●▫·►▶➤✓✔]+(?=\S)/;
const NOTE_CLAUSE = /^(?:about|approximately|approx\.?|roughly \d|around \d|or more|or less|preferably|ideally|such as|like|e\.g\.|i\.e\.|see note|white and green parts|white parts only|green parts only|white and light green parts|from about|from \d|weighing|the best you can find|good quality|store-?bought|homemade|zest(?:ed)? and juice(?:d)?|juice(?:d)? and zest(?:ed)?|zest only|juice only)\b/i;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PREPARATION_ALTERNATION = PREPARATION_WORDS.map(escapeRegExp).join('|');
const PREPARATION_CLAUSE = new RegExp(`^(?:(?:${PREPARATION_ADVERBS.join('|')})\\s+)*(?:${PREPARATION_ALTERNATION})(?:\\b|$)`, 'i');
/** The whole clause is a preparation ("minced", "finely chopped"), so it cannot be the name: "3 cloves, minced". */
const PREPARATION_ONLY = new RegExp(`^(?:(?:${PREPARATION_ADVERBS.join('|')})\\s+)*(?:${PREPARATION_ALTERNATION})$`, 'i');
const TRAILING_PREPARATION = new Set([...LEADING_PREPARATION, 'crushed', 'toasted', 'roasted', 'cut']);

/** A weight of chopped, diced or peeled tomatoes is the tinned product: UK recipes write "400g chopped tomatoes" without the tin. */
const TINNED_BY_WEIGHT = /^(?:chopped|diced|crushed|peeled|whole peeled|plum|fire[- ]roasted|stewed) tomato(?:es)?$/i;

/** Collapse whitespace and drop a leading bullet, keeping the author's characters. A leading number is never a bullet. */
function cleanLine(rawText: string): string {
  return rawText
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(BULLET_PREFIX, '')
    .trim();
}

/** Vulgar fractions become ASCII before NFKC, which would otherwise turn "1½" into "11⁄2". */
function parseableText(text: string): string {
  return text
    .replace(MIXED_VULGAR, (_match, digit: string, fraction: string) => `${digit} ${ASCII_FRACTIONS[fraction]}`)
    .replace(VULGAR_GLYPH, (fraction) => ASCII_FRACTIONS[fraction])
    .normalize('NFKC')
    .replace(/⁄/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

type UnitMatch = { code: string | null; rest: string; note: string | null; descriptor: string | null };

function matchUnit(text: string): UnitMatch {
  const attempt = (value: string): { code: string; rest: string } | null => {
    for (const { definition, alias } of UNIT_ALIASES) {
      const candidate = value.slice(0, alias.length);
      const same = CASE_SENSITIVE_ALIASES.has(alias) ? candidate === alias : candidate.toLowerCase() === alias.toLowerCase();
      if (!same) continue;
      const after = value.slice(alias.length);
      // The unit may be glued to a period, a comma, an alternate measure ("cup/240 ml") or an addition ("cup + 2 tbsp").
      if (after !== '' && !/^[\s.,;/+()]/.test(after)) continue;
      const rest = after.replace(/^\.(?=\s|$|[,;/+()])/, '').trim();
      if (NOT_A_UNIT_BEFORE[definition.code]?.test(rest)) continue;
      return { code: definition.code, rest };
    }
    return null;
  };
  const direct = attempt(text);
  if (direct) return { ...direct, note: null, descriptor: null };
  const qualified = text.match(MEASURE_QUALIFIER);
  if (qualified) {
    const retry = attempt(qualified[2]);
    if (retry) return { ...retry, note: qualified[1].toLowerCase(), descriptor: null };
  }
  const sized = text.match(MEASURE_ADJECTIVE);
  if (sized) {
    const retry = attempt(sized[2]);
    if (retry) return { ...retry, note: null, descriptor: sized[1].toLowerCase() };
  }
  return { code: null, rest: text, note: null, descriptor: null };
}

/** The two units share a family and can be summed: "1 cup + 2 tbsp" is 18 tbsp. */
function sameFamily(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && unitDefinition(a)?.family === unitDefinition(b)?.family;
}

function isMeasuredUnit(code: string | null): boolean {
  const family = unitDefinition(code)?.family ?? '';
  return family.startsWith('mass-') || family.startsWith('volume-');
}

function isMassUnit(code: string | null): boolean {
  return (unitDefinition(code)?.family ?? '').startsWith('mass-');
}

function isContainerUnit(code: string | null): boolean {
  return CONTAINER_UNITS.some((definition) => definition.code === code);
}

/** "cloves" for unit "clove": the fallback name when a line names only a measure ("3 cloves, minced"). */
function unitWord(code: string): string {
  return unitDefinition(code)?.plural ?? code;
}

type QuantityParse = { quantity: Rational | null; quantityMax: Rational | null; approximate: boolean; rest: string; note: string | null };

function parseQuantity(text: string): QuantityParse {
  let rest = text;
  let approximate = false;
  const approx = rest.match(APPROXIMATE_PREFIX);
  if (approx) { approximate = true; rest = rest.slice(approx[0].length); }

  const range = rest.match(RANGE_PATTERN);
  if (range) {
    return { quantity: parseRationalToken(range[1]), quantityMax: parseRationalToken(range[2]), approximate: true, rest: rest.slice(range[0].length).trim(), note: null };
  }
  const size = rest.match(SIZE_PREFIX);
  if (size) return { quantity: rational(1), quantityMax: null, approximate, rest: size[3].trim(), note: `${size[1]}-${size[2].toLowerCase()}` };
  const single = rest.match(QUANTITY_PATTERN);
  if (single) return { quantity: parseRationalToken(single[1]), quantityMax: null, approximate, rest: rest.slice(single[0].length).trim(), note: null };
  for (const [pattern, value, roughly] of WORD_QUANTITIES) {
    const word = rest.match(pattern);
    if (word && /^\s|^$/.test(rest.slice(word[0].length))) {
      return { quantity: value, quantityMax: null, approximate: approximate || roughly, rest: rest.slice(word[0].length).trim(), note: null };
    }
  }
  return { quantity: null, quantityMax: null, approximate, rest, note: null };
}

/** "boneless" + "skinless chicken thighs": a lone qualifier before the comma shares the noun that follows it. */
function joinsQualifiers(first: string, second: string): boolean {
  const firstWords = first.toLowerCase().split(' ');
  const secondWords = second.toLowerCase().split(' ');
  if (firstWords.length > 2 || !firstWords.every((word) => SHARED_HEAD_QUALIFIERS.has(word))) return false;
  if (secondWords.length < 2 || !SHARED_HEAD_QUALIFIERS.has(secondWords[0])) return false;
  return !PREPARATION_CLAUSE.test(second) && !NOTE_CLAUSE.test(second) && !startsWithAmount(second);
}

function isSeasoningName(clause: string): boolean {
  return !PREPARATION_CLAUSE.test(clause) && !startsWithAmount(clause) && groceryCategoryFor(normalizeIngredientName(clause)) === 'Spices & Seasonings';
}

/**
 * Splits "chicken thighs, diced" into the name and what follows. Everything after the first comma is a preparation
 * by default; the exceptions are notes ("about 2 cups", "such as chuck"), a qualifier that shares the noun after it
 * ("boneless, skinless chicken thighs") and a list of seasonings ("salt, pepper" → "salt and pepper").
 */
function splitPreparation(text: string): { name: string; preparation: string | null; notes: string[] } {
  const clauses = text.split(/\s*(?:,|;|\s-\s|\s–\s)\s*/).map((clause) => clause.trim()).filter(Boolean);
  const nameClauses: string[] = [];
  const preparationClauses: string[] = [];
  const notes: string[] = [];
  clauses.forEach((clause, index) => {
    // The first clause is the name unless it is nothing but a preparation ("3 cloves, minced" → name comes from the unit).
    if (index === 0) {
      if (PREPARATION_ONLY.test(clause)) preparationClauses.push(clause);
      else nameClauses.push(clause);
      return;
    }
    if (NOTE_CLAUSE.test(clause) || /^\d/.test(clause)) { notes.push(clause); return; }
    if (nameClauses.length === 1 && !preparationClauses.length) {
      if (joinsQualifiers(nameClauses[0], clause)) { nameClauses[0] = `${nameClauses[0]} ${clause}`; return; }
      if (isSeasoningName(nameClauses[0]) && isSeasoningName(clause)) { nameClauses[0] = `${nameClauses[0]} and ${clause}`; return; }
    }
    preparationClauses.push(clause);
  });

  // A trailing participle without a comma: "2 eggs beaten", "parsley finely chopped".
  const words = nameClauses.join(' ').split(' ');
  const trailing: string[] = [];
  while (words.length > 1 && TRAILING_PREPARATION.has(words[words.length - 1].toLowerCase())) {
    trailing.unshift(words.pop() as string);
    if (words.length > 1 && PREPARATION_ADVERBS.includes(words[words.length - 1].toLowerCase())) trailing.unshift(words.pop() as string);
  }
  if (trailing.length) preparationClauses.unshift(trailing.join(' '));
  return { name: words.join(' '), preparation: preparationClauses.join(', ') || null, notes };
}

/** "finely chopped parsley" → ["finely chopped", "parsley"]; product names such as "ground beef" are left alone. */
function splitLeadingPreparation(name: string): { name: string; preparation: string | null } {
  const words = name.split(' ');
  let index = 0;
  while (index < words.length && PREPARATION_ADVERBS.includes(words[index].toLowerCase())) index += 1;
  if (!LEADING_PREPARATION.has(words[index]?.toLowerCase() ?? '')) return { name, preparation: null };
  while (index < words.length && LEADING_PREPARATION.has(words[index].toLowerCase())) {
    index += 1;
    if (words[index]?.toLowerCase() === 'and' && LEADING_PREPARATION.has(words[index + 1]?.toLowerCase() ?? '')) index += 1;
  }
  if (index >= words.length) return { name, preparation: null };
  return { name: words.slice(index).join(' '), preparation: words.slice(0, index).join(' ') };
}

function trimName(value: string): string {
  return value.replace(/^[\s,;:.!?\-–—]+|[\s,;:.!?\-–—]+$/g, '').replace(/\s+/g, ' ');
}

/** Caption chatter glued to an ingredient: "...water to loosen & feel free to add a bit of Parmesan!!" */
const CHATTER_CLAUSE = /(?:\s*(?:&|,|;|-|–|—)\s*(?:and\s+)?|\s+(?:and|or)\s+|\s+)(?:feel free to|if you like|if you'd like|if you want|if you fancy|you can also|you could also)\b.*$/i;
/** Herb-shaped measures: by the bunch or the handful, "coriander" is the leaf, not the seed. */
const HERB_UNITS = new Set(['bunch', 'handful', 'sprig', 'leaf', 'stalk']);

function startsWithAmount(text: string): boolean {
  return parseQuantity(text).quantity !== null || matchUnit(text).code !== null;
}

type Alternative = { name: string; note: string; needsReview: boolean };

/**
 * "X or Y" lines. The alternative becomes a note and the name is X, except that a lone qualifier shares the
 * noun that follows ("fresh or frozen corn" → "fresh corn"). An X that is nothing we recognise keeps the whole
 * phrase and asks for a look rather than inventing a name.
 */
function splitAlternative(name: string, quantified: boolean): Alternative | null {
  const alternative = name.match(/^(.+?)\s+or\s+(.+)$/i);
  if (!alternative) return null;
  const [, primary, other] = alternative;
  const note = `or ${other}`;
  const primaryWords = primary.split(' ');
  const otherWords = other.split(' ');
  const loneQualifier = primaryWords.length === 1 && SHARED_HEAD_QUALIFIERS.has(primary.toLowerCase());
  const keepWhole: Alternative = { name, note: '', needsReview: true };
  const keepPrimary: Alternative = { name: primary, note, needsReview: !quantified };
  if (loneQualifier && otherWords.length > 1 && !startsWithAmount(other)) {
    return { name: `${primary} ${otherWords.slice(1).join(' ')}`, note, needsReview: false };
  }
  // "Spray oil or 1 tbsp olive oil" names two measures; "2 large or 1 small onion" would leave a bare "large".
  if (startsWithAmount(other)) return loneQualifier ? keepWhole : keepPrimary;
  return groceryCategoryFor(normalizeIngredientName(primary)) === 'Other' ? keepWhole : keepPrimary;
}

export function parseIngredientLine(rawText: string, section: string | null = null): Ingredient {
  const normalizedText = cleanLine(rawText);
  const notes: string[] = [];
  let optional = false;
  let toTaste = false;
  let needsReview = false;

  // Parentheticals are notes ("14 oz", "250g", "see note") or the optional flag; never part of the name.
  let working = parseableText(normalizedText).replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (_match, round: string | undefined, square: string | undefined) => {
    const inner = (round ?? square ?? '').trim();
    if (!inner) return ' ';
    if (/\boptional\b/i.test(inner)) {
      optional = true;
      const remainder = trimName(inner.replace(/\boptional\b/i, ''));
      if (remainder) notes.push(remainder);
    } else {
      notes.push(inner);
    }
    return ' ';
  }).replace(/\s+/g, ' ').trim();
  if (/(?:,\s*|\s+)optional$/i.test(working)) { optional = true; working = working.replace(/(?:,\s*|\s+)optional$/i, '').trim(); }
  // "optional: 1 tsp chili flakes" and "Optional - fresh herbs".
  const optionalPrefix = working.match(/^optional\s*(?:[:\-–—]\s*|\s+)(?=\S)/i);
  if (optionalPrefix) { optional = true; working = working.slice(optionalPrefix[0].length); }
  // "...water to loosen & feel free to add a bit of Parmesan!!": the chatter after the ingredient is dropped.
  const chatter = working.match(CHATTER_CLAUSE);
  if (chatter && chatter.index) working = trimName(working.slice(0, chatter.index));

  // "to taste", "for frying", "to loosen": the cook decides the amount. The phrase is kept as a note.
  let cookDecides = working.match(COOK_DECIDES);
  while (cookDecides && cookDecides.index !== undefined) {
    toTaste = true;
    notes.push(trimName(cookDecides[0]).toLowerCase());
    working = trimName(`${working.slice(0, cookDecides.index)} ${working.slice(cookDecides.index + cookDecides[0].length)}`);
    cookDecides = working.match(COOK_DECIDES);
  }

  const juice = working.match(JUICE_OF);
  if (juice) { notes.unshift(juice[1].toLowerCase()); working = juice[2]; }

  const parsed = parseQuantity(working);
  let { quantity, approximate } = parsed;
  const quantityMax = parsed.quantityMax;
  working = parsed.rest;
  if (parsed.note) notes.push(parsed.note);

  // "1 x 400g can" / "1 15 oz can": the size between the count and the container is a note.
  const multiplier = quantity ? working.match(MULTIPLIER_PATTERN) : null;
  if (multiplier) { notes.push(multiplier[1].replace(/\s+/g, '')); working = working.slice(multiplier[0].length).trim(); }
  const containerSize = quantity && !multiplier ? working.match(CONTAINER_SIZE) : null;
  if (containerSize) { notes.push(`${containerSize[1]} ${containerSize[2].toLowerCase()}`); working = working.slice(containerSize[0].length).trim(); }
  // "1 2-inch piece ginger": the size after the count is a note.
  const sizeAfterCount = quantity ? working.match(SIZE_PREFIX) : null;
  if (sizeAfterCount) { notes.push(`${sizeAfterCount[1]}-${sizeAfterCount[2].toLowerCase()}`); working = sizeAfterCount[3].trim(); }
  if (quantity) working = working.replace(/^(?:a|an)\s+(?=\S)/i, '');

  const unit = matchUnit(working);
  working = unit.rest;
  if (unit.note) notes.push(unit.note);
  let descriptor: string | null = unit.descriptor;
  if (unit.code && !quantity) { quantity = rational(1); approximate = true; }
  if (unit.code && unitDefinition(unit.code)?.approximate) approximate = true;
  let unitCode: string | null = quantity ? unit.code ?? 'each' : null;
  // "1 cup/240 ml milk": the alternate measure is a note. "1 cup + 2 tbsp flour": the addition is summed in the smaller unit (18 tbsp).
  const alternate = unit.code ? working.match(ALTERNATE_MEASURE) : null;
  if (alternate) { notes.push(`${alternate[1]} ${alternate[2].replace(/\.$/, '')}`); working = working.slice(alternate[0].length); }
  const added = unit.code && quantity ? working.match(ADDED_MEASURE) : null;
  if (added && quantity && unit.code) {
    const extraAmount = parseRationalToken(added[1]);
    const extraUnit = matchUnit(added[2]).code;
    if (extraAmount && extraUnit && sameFamily(unit.code, extraUnit)) {
      const smaller = (unitDefinition(unit.code)?.factor ?? 1) <= (unitDefinition(extraUnit)?.factor ?? 1) ? unit.code : extraUnit;
      notes.push(`${formatRational(quantity)} ${unit.code} + ${formatRational(extraAmount)} ${extraUnit}`);
      quantity = fromBase(addRational(toBase(quantity, unit.code), toBase(extraAmount, extraUnit)), smaller);
      unitCode = smaller;
      working = working.slice(added[0].length);
    }
  }
  if (quantity) working = working.replace(/^of\s+/i, '');
  // "1 cup packed brown sugar": how full the cup is belongs in the note, not the name.
  const packed = unit.code ? working.match(MEASURE_QUALIFIER) : null;
  if (packed) { notes.push(packed[1].toLowerCase()); working = packed[2]; }

  // "400g tin tomatoes": the weight is the measure, the container is a note that also routes it to the canned aisle.
  const container = isMeasuredUnit(unitCode) ? working.match(CONTAINER_WORDS) : null;
  if (container) { notes.push(container[1].toLowerCase()); working = container[2]; }

  const split = splitPreparation(working);
  notes.push(...split.notes);
  let name = split.name;
  let preparation = split.preparation;
  const productName = isContainerUnit(unitCode) || (isMassUnit(unitCode) && TINNED_BY_WEIGHT.test(name));
  if (!productName) {
    const leading = splitLeadingPreparation(name);
    if (leading.preparation) {
      name = leading.name;
      preparation = [leading.preparation, preparation].filter(Boolean).join(', ');
    }
  }

  const alternative = splitAlternative(name, Boolean(quantity));
  if (alternative) {
    name = alternative.name;
    if (alternative.note) notes.push(alternative.note);
    if (alternative.needsReview) needsReview = true;
  }

  const sized = name.match(SIZE_DESCRIPTORS);
  if (sized) { descriptor = descriptor ?? sized[1].toLowerCase(); name = sized[2]; }

  name = trimName(name);
  if (/^garlic cloves?$|^cloves? (?:of )?garlic$/i.test(name) && (unitCode === 'each' || unitCode === null)) {
    name = 'garlic';
    if (quantity) unitCode = 'clove';
  }
  // A line that names only a measure ("3 cups", "3 cloves, minced") is listed under the measure word, asks for a look
  // and stays off the grocery list until it is named.
  const measureOnly = !name && unitCode !== null && unitCode !== 'each';
  if (measureOnly) { name = unitWord(unitCode as string); needsReview = true; }
  const ingredientName = name || normalizedText;
  let normalizedIngredient = normalizeIngredientName(ingredientName);
  if (normalizedIngredient === 'coriander' && unitCode && HERB_UNITS.has(unitCode)) normalizedIngredient = 'cilantro';
  const neverShopped = SKIP_GROCERY.test(normalizedIngredient) || SKIP_GROCERY.test(ingredientName);
  const skipGrocery = neverShopped || measureOnly;
  const cannedHint = unitCode === 'can' || unitCode === 'jar' || notes.some((note) => /^(?:tins?|cans?|jars?|tinned)$/i.test(note)) || (productName && isMassUnit(unitCode)) ? 'canned ' : '';
  const groceryCategory = groceryCategoryFor(`${cannedHint}${normalizedIngredient}`);

  // An unquantified seasoning is normal ("Kosher salt", "Pepper"): the cook decides how much.
  if (!quantity && groceryCategory === 'Spices & Seasonings') toTaste = true;
  if (!quantity && !toTaste) needsReview = true;
  if (!name || /[<>]/.test(ingredientName)) needsReview = true;
  if (neverShopped) needsReview = false;

  return {
    id: makeId('ing'),
    rawText: normalizedText,
    quantity,
    unit: unitCode,
    normalizedUnit: unitCode,
    ingredientName,
    normalizedIngredient,
    descriptor,
    preparation,
    groceryCategory,
    optional,
    section,
    confidence: measureOnly ? 0.35 : needsReview ? 0.62 : approximate ? 0.85 : 0.96,
    needsReview,
    quantityMax,
    approximate,
    toTaste,
    skipGrocery,
    note: notes.length ? notes.join('; ') : null,
  };
}

function emptyDraft(sourceType: RecipeDraft['sourceType']): RecipeDraft {
  return {
    id: makeId('recipe'), title: '', description: '', heroImage: null,
    sourceType, sourceURL: null, sourceName: null, author: null,
    servings: null, prepTime: null, cookTime: null, totalTime: null,
    cuisine: null, categories: [], tags: [], ingredients: [], instructions: [],
    rating: null, favorite: false, notes: '', attachments: [],
  };
}

function parseMinutes(text: string, label: string): number | null {
  const match = text.match(new RegExp(`${label}(?:\\s+time)?\\s*[:–-]?\\s*(\\d+)\\s*(?:min|minutes|mins)`, 'i'));
  return match ? Number(match[1]) : null;
}

const INGREDIENT_HEADINGS = [
  'ingredients', 'ingredient', 'ingredient list', 'ingredients list', "what you'll need", 'what you need', 'you will need',
  "you'll need", 'shopping list', 'grocery list',
];
const INSTRUCTION_HEADINGS = [
  'directions', 'direction', 'instructions', 'instruction', 'method', 'methods', 'preparation', 'how to make it', 'how to make',
  'how to', 'how i made it', 'how i make it', 'steps', 'to make', "let's cook", 'make it', 'process', 'assembly', 'to assemble',
  'cooking instructions', 'recipe steps',
];
/** Longest first so "how to make it" wins over "how to"; apostrophes are optional and may be curly. */
const headingAlternation = (headings: string[]): string => [...headings]
  .sort((a, b) => b.length - a.length)
  .map((heading) => escapeRegExp(heading).replace(/'/g, "(?:'|’)?"))
  .join('|');
const HEADING_LEAD = "(?:here(?:'|’)?s (?:the |my )?|the |my |full )?";
const INGREDIENT_HEADING = new RegExp(`^${HEADING_LEAD}(?:${headingAlternation(INGREDIENT_HEADINGS)})(?: below)?$`, 'i');
const INSTRUCTION_HEADING = new RegExp(`^${HEADING_LEAD}(?:${headingAlternation(INSTRUCTION_HEADINGS)})(?: below)?$`, 'i');
/**
 * A heading written inline ("...loves it. INGREDIENTS 👇 2 chicken breasts") starts a new line. The heading text is
 * consumed by the match, so "How to make it:" is never split a second time at "make it".
 */
const INLINE_HEADING = new RegExp(`(?<!here(?:'|’)?s|\\bthe|\\bmy|\\bfull)\\s+(${headingAlternation([...INGREDIENT_HEADINGS, ...INSTRUCTION_HEADINGS])})(?=\\s*(?:[:：]|[👇⬇]|\\(|$))`, 'gi');
/** Content that follows the heading on the same line ("Ingredients: 1 lb shrimp") moves to its own line. */
const INLINE_HEADING_TAIL = new RegExp(`^((?:${headingAlternation([...INGREDIENT_HEADINGS, ...INSTRUCTION_HEADINGS])})\\s*(?:[:：]|[👇⬇]+))\\s+(?=\\S)`, 'gim');
/** "Recipe:", "Full recipe 👇", "Here's the recipe": announces the recipe without saying which block follows. */
const RECIPE_MARKER = /^(?:here(?:'|’)?s (?:the |my )?|the |my |full )?recipe(?: below)?\s*(?:[:：]|[👇⬇]+)?$/i;
/** Promotion lines that can sit anywhere in a caption and never carry recipe content. */
const PROMO_LINE = /\blink in (?:my |the )?bio\b|\bfull recipe (?:on|at|in|via)\b|\brecipe (?:link|linked)\b|\bswipe up\b|\b(?:tap|click) the link\b/i;
const STEP_MARKER_ONLY = /^step\s+\d+\s*[:.)-]?$/i;
const NUMBERED_LINE = /^(?:\d+\s*[.)]|step\s+\d+\b)/i;

/** Timing labels that are never the start of a step ("Prep 10 min") and verbs that can be ("Bake 25 minutes."). */
const TIME_LABEL = '(?:prep|preparation|total|active|inactive|hands-on|marinating|rising|proofing|time)';
const TIME_VERB = '(?:cook|cooking|bake|baking|rest|resting|chill|chilling|marinate|freeze|freezing)';
const DURATION = '\\d+(?:\\s*(?:-|–|to)\\s*\\d+)?\\s*(?:min(?:ute)?s?|h|hrs?|hours?)\\.?(?:\\s*(?:and\\s+)?\\d+\\s*min(?:ute)?s?\\.?)?';
const TIME_SEGMENT = `(?:${TIME_LABEL}|${TIME_VERB})(?:\\s+time)?\\s*[:–-]?\\s*${DURATION}`;
/** In the steps a verb head needs "time" or a colon ("Cook time: 20 minutes") so that "Bake 25 minutes." stays a step. */
const STRICT_TIME_SEGMENT = `(?:${TIME_LABEL}(?:\\s+time)?\\s*[:–-]?|${TIME_VERB}(?:\\s+time\\s*[:–-]?|\\s*[:–-]))\\s*${DURATION}`;
/** Recipe metadata that is skipped while reading the header and the ingredient block. */
const META_LINE = new RegExp(`^(?:serves?|servings?|yield|yields|makes|portions?)\\s*[:–-]?\\s*\\d|^${TIME_SEGMENT}|^(?:prep|cook|cooking|total) time\\b`, 'i');
/** A whole line of timings ("Prep 10 min | Cook 20 min", "Cook time: 20 minutes") inside the steps. */
const TIME_ONLY_LINE = new RegExp(`^${STRICT_TIME_SEGMENT}(?:\\s*[|,;/·•]\\s*${TIME_SEGMENT})*$`, 'i');
/** A whole line giving the yield ("Serves 4", "Makes 12 muffins"), which may also close a caption after the steps. */
const SERVINGS_LINE = /^(?:serves?|servings?|yield|yields|makes|portions?)\s*[:–-]?\s*(?:about |approx\.? |approximately )?\d+(?:\s*(?:-|–|to)\s*\d+)?(?:\s+\w+)?\.?$/i;
const INGREDIENT_LOOKING = new RegExp(`^(?:${NUMBER_TOKEN}(?:\\s|[a-zA-Z]|$)|(?:a |an |one )?(?:pinch|splash|dash|handful|knob|drizzle|squeeze|glug|sprinkle|bunch|clove|can|tin|jar|cup|juice|zest|half)s?\\b)`, 'i');
/** "#chili" is a hashtag; "#1 Weeknight Chili" is a numbered title. */
const HASHTAG_LINE = /^#(?!\d+\s)/;
const SOCIAL_TAIL = new RegExp(`${HASHTAG_LINE.source}|^(?:save|share|follow|comment|like|credit|video|tag|dm|link in bio|recipe by|inspired by|via|📌|🔗)\\b`, 'i');
/** Caption prose rather than a section name: "Trust me on this one:", "Here's how I made it:". */
const PROSE_HINT = /\b(?:here(?:'|’)?s|here is|this|these|those|you|your|me|my|i|we|our|trust|below|save|swipe|tap|click|comment|dm|link|follow|love|loved|make|made|try|tried)\b/i;
const MARKER_JUNK = new RegExp(`^[^\\p{L}\\p{N}${VULGAR}(]+`, 'u');
/** Pictographs plus the joiners that build them (ZWJ, variation selector, keycap, flags). Digits are never emoji here. */
const EMOJI_EDGE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200D\uFE0F\u20E3\u{1F1E6}-\u{1F1FF}]/u;

function normalizeRecipeCapture(text: string): string[] {
  const expanded = text
    .replace(/\r/g, '')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/([1-9])\uFE0F?\u20E3/g, '\n$1. ')
    .replace(/\s*[•●▪▫◦]\s*/g, '\n• ')
    .replace(INLINE_HEADING, '\n$1')
    .replace(INLINE_HEADING_TAIL, '$1\n')
    .replace(/\s+(?=\d{1,2}[.)]\s+[A-Za-z])/g, '\n');
  return expanded
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** "Ingredients (Serves 3–4) 👇:" → "Ingredients" so it can be compared with the heading words. */
function captureHeading(line: string): string {
  return line
    .replace(/^[-–—•●▪▫◦*\s]+/, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[:：]\s*$/, '')
    .replace(/[^A-Za-z'’ &]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripCaptureMarker(line: string): string {
  return line
    .replace(/^\s*(?:[-–—•●▪▫◦*]|\d+\s*[.)]|step\s+\d+\s*[:.)-])\s*/i, '')
    .replace(MARKER_JUNK, '')
    .trim();
}

function isSocialCaptionTail(line: string): boolean {
  return SOCIAL_TAIL.test(line)
    || /^(?:more posts from|view all \d+ comments?|log in|sign up)\b/i.test(line);
}

function cleanTitle(line: string): string {
  let title = line
    .replace(/^[\s\-–—•●▪▫◦*]+/, '')
    // "#1 Weeknight Chili" keeps its number; a leading hashtag word is decoration.
    .replace(/^#+(?!\d+\s)/, '')
    .replace(/(?:\s*#[\p{L}\p{N}_]+)+\s*$/u, '')
    // "Weeknight Pasta 🍝 Full recipe below 👇": the promo tail is not part of the dish name.
    .replace(/\s*[-–—|:,]?\s*(?:(?:full |the )?recipe(?: is)? (?:below|in (?:my |the )?bio|linked|link in bio)|link in (?:my |the )?bio|swipe up)\b.*$/i, '')
    .trim();
  // Trailing and leading emoji are decoration, not part of the dish name.
  const parts = [...title];
  while (parts.length && (EMOJI_EDGE.test(parts[parts.length - 1]) || /[\s|~✨🔥]/.test(parts[parts.length - 1]))) parts.pop();
  while (parts.length && (EMOJI_EDGE.test(parts[0]) || /[\s|~✨🔥]/.test(parts[0]))) parts.shift();
  title = parts.join('').replace(/\s+/g, ' ').trim();
  return title.replace(/[\s:;,\-–—]+$/, '').trim();
}

/** "1 lb beef" is an ingredient; "3 Ingredient Pancakes", "5-Minute Hummus" and "Sheet Pan Chicken" are titles. */
function looksLikeMeasuredIngredient(line: string): boolean {
  const text = stripCaptureMarker(line);
  if (!INGREDIENT_LOOKING.test(text)) return false;
  const parsed = parseIngredientLine(text);
  return parsed.quantity !== null && parsed.unit !== null && parsed.unit !== 'each';
}

function isTitleCandidate(line: string): boolean {
  if (!line || /^https?:\/\//i.test(line) || /^@\w+/.test(line) || HASHTAG_LINE.test(line)) return false;
  if (META_LINE.test(line) || SERVINGS_LINE.test(line) || RECIPE_MARKER.test(line) || PROMO_LINE.test(line) || STEP_MARKER_ONLY.test(line)) return false;
  if (isSocialCaptionTail(line)) return false;
  return cleanTitle(line).length > 0;
}

/** The first caption line that reads as a dish name. Nothing after a heading or a measured ingredient line is a title. */
function findTitleIndex(lines: string[]): number {
  for (const [index, line] of lines.entries()) {
    const heading = captureHeading(line);
    if (INGREDIENT_HEADING.test(heading) || INSTRUCTION_HEADING.test(heading) || looksLikeMeasuredIngredient(line)) return -1;
    if (isTitleCandidate(line)) return index;
  }
  return -1;
}

/** Words that open a part of the recipe rather than name an ingredient: "For the sauce", "To serve", "Topping". */
const SECTION_LEAD = /^(?:for the|for my|for your|for|to serve|to garnish|to finish|to assemble|garnish|garnishes|topping|toppings|sauce|dressing|marinade|filling|crust|base|glaze|frosting|icing|batter|dough|coating|crumble|streusel|wet ingredients|dry ingredients|optional toppings|optional extras|extras)\b/i;
const SECTION_WORD = /\b(?:sauce|dressing|marinade|filling|crust|base|topping|toppings|garnish|glaze|frosting|icing|batter|dough|ingredients|extras|coating|crumble|streusel|syrup|slaw|assembly)\b/i;
/** Caption sign-offs that end the ingredient block: "Method is in the caption!", "Follow for more", "Enjoy!" */
const CAPTION_SIGN_OFF = /\b(?:method|recipe|link in bio|check (?:out |on )?my bio|follow|save this|comment|share|tag|enjoy|app|episode|video|full recipe|recipe below)\b/i;
const VULGAR_ANYWHERE = new RegExp(`[${VULGAR}]`);
const EMOJI_ANYWHERE = new RegExp(EMOJI_EDGE.source, 'gu');

/**
 * A line that names a group of ingredients rather than an ingredient: no digits or measure words, at most six words,
 * and it ends in ":", is written in capitals ("FOR THE SAUCE") or opens with a section word ("To serve", "Topping").
 * Capitals alone do not make "SALT" or "OLIVE OIL" a heading. Shared with the add-recipe sheet.
 */
export function isIngredientSectionHeading(line: string): boolean {
  const raw = line.replace(/^[-–—•●▪▫◦*\s]+/, '').trim();
  // "To serve: lime wedges" carries content after the colon: a heading plus an ingredient, not a heading.
  if (/[:：]\s*[^\s:：👇⬇]/u.test(raw)) return false;
  const text = captureHeading(raw);
  if (!text || /\d/.test(text) || VULGAR_ANYWHERE.test(text)) return false;
  if (text.split(' ').length > 6 || startsWithAmount(text)) return false;
  if (/[:：]\s*[👇⬇\s]*$/u.test(raw)) return true;
  if (SECTION_LEAD.test(text)) return true;
  const allCaps = /^[^a-z]*$/.test(text) && /[A-Z]{2,}/.test(text);
  if (!allCaps || CAPTION_SIGN_OFF.test(text)) return false;
  if (SECTION_WORD.test(text)) return true;
  const normalized = normalizeIngredientName(text);
  return groceryCategoryFor(normalized) === 'Other' && !SKIP_GROCERY.test(normalized);
}

/** Inside the ingredient block any short line ending in ":" names the next group ("Lighter Caesar dressing:"). */
function looksLikeSectionHeading(line: string): boolean {
  if (/^\d/.test(line)) return false;
  if (/:$/.test(line)) return line.split(' ').length <= 10;
  return isIngredientSectionHeading(line);
}

/** "To serve: lime wedges" carries both the group name and its first ingredient. */
function splitInlineSection(line: string): { section: string; rest: string } | null {
  const match = line.match(/^([^:：]{2,40})[:：]\s+(\S.*)$/);
  if (!match || /\d/.test(match[1])) return null;
  const section = match[1].trim();
  if (!SECTION_LEAD.test(section) && !/^[^a-z]*$/.test(section)) return null;
  return isIngredientSectionHeading(`${section}:`) ? { section, rest: match[2].trim() } : null;
}

/** A prose line inside the ingredient block that names nothing to buy and reads as the author signing off. */
function endsIngredientBlock(line: string): boolean {
  const text = line.replace(EMOJI_ANYWHERE, '').replace(/[\s'’"”)]+$/u, '').trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const parsed = parseIngredientLine(text);
  if (parsed.quantity !== null || parsed.unit !== null || parsed.toTaste || parsed.skipGrocery) return false;
  if (groceryCategoryFor(parsed.normalizedIngredient) !== 'Other') return false;
  return CAPTION_SIGN_OFF.test(text) || (words.length > 6 && /[!?.]$/.test(text));
}

/**
 * Before the ingredient block a line ending in ":" opens it only when it reads as a section name ("For the sauce:",
 * "Dressing:") or when an ingredient line follows. Prose such as "Trust me on this one:" stays in the description,
 * and prose that introduces the list ("Here's how I made it:") switches mode without becoming a section name.
 */
function metaSectionOpener(line: string, nextLine: string | undefined): 'section' | 'switch' | null {
  if (/^\d/.test(line) || !/:$/.test(line)) return null;
  const body = line.slice(0, -1).trim();
  if (!body || /[.!?]/.test(body) || body.split(' ').length > 10) return null;
  const nextIsIngredient = nextLine !== undefined && INGREDIENT_LOOKING.test(stripCaptureMarker(nextLine));
  if (PROSE_HINT.test(body)) return nextIsIngredient ? 'switch' : null;
  return /^for (?:the|my|your)\b/i.test(body) || body.split(' ').length <= 5 || nextIsIngredient ? 'section' : null;
}

export function parseRecipeText(text: string): { draft: RecipeDraft; warnings: string[] } {
  const source = text.slice(0, 30_000);
  const lines = normalizeRecipeCapture(source);
  const draft = emptyDraft('pasted-text');
  const titleIndex = findTitleIndex(lines);
  draft.title = titleIndex >= 0 ? cleanTitle(lines[titleIndex]) : 'Untitled recipe';
  const wholeText = lines.join('\n');
  // "Serves 3–4" yields the lower bound: the recipe comfortably feeds that many.
  draft.servings = Number(wholeText.match(/\b(?:serves?|servings?|yields?|makes|portions?)\s*[:–-]?\s*(\d+)/i)?.[1] ?? '') || null;
  draft.prepTime = parseMinutes(wholeText, 'prep');
  draft.cookTime = parseMinutes(wholeText, 'cook');
  draft.totalTime = parseMinutes(wholeText, 'total') ??
    (draft.prepTime !== null && draft.cookTime !== null ? draft.prepTime + draft.cookTime : null);

  // "done": the author signed off ("Method is in the caption!") and the rest of the caption is chatter unless a
  // heading or a numbered step appears.
  let mode: 'meta' | 'ingredients' | 'instructions' | 'done' = 'meta';
  let ingredientSection: string | null = null;
  let instructionSection: string | null = null;
  const descriptionLines: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (index === titleIndex || PROMO_LINE.test(line) || RECIPE_MARKER.test(line)) continue;
    const heading = captureHeading(line);
    if (INGREDIENT_HEADING.test(heading)) { mode = 'ingredients'; ingredientSection = null; continue; }
    if (INSTRUCTION_HEADING.test(heading)) { mode = 'instructions'; instructionSection = null; continue; }
    // Metadata is skipped freely before the steps. Inside them only a whole line of timings or a yield is skipped,
    // so a step such as "Bake 25 minutes until golden." survives.
    if (mode === 'instructions' ? TIME_ONLY_LINE.test(line) || SERVINGS_LINE.test(line) : META_LINE.test(line)) continue;
    // A bare "Step 1" (NYT Cooking's copied format) labels the next line rather than being a step itself.
    if (STEP_MARKER_ONLY.test(line)) { mode = 'instructions'; continue; }
    let cleanMarker = stripCaptureMarker(line);
    const numbered = NUMBERED_LINE.test(line);
    if (mode === 'done') {
      if (!numbered) continue;
      mode = 'instructions';
    }
    if (mode === 'meta') {
      const opener = metaSectionOpener(line, lines[index + 1]);
      // Without a colon, a section name opens the list only when it says "for the" or an ingredient line follows it.
      const nextLine = lines[index + 1];
      const nextIsIngredient = nextLine !== undefined && INGREDIENT_LOOKING.test(stripCaptureMarker(nextLine));
      const bareHeading = !/:$/.test(line) && looksLikeSectionHeading(line) && (/^for the\b/i.test(line) || nextIsIngredient);
      if (opener === 'section' || bareHeading) {
        mode = 'ingredients';
        ingredientSection = cleanTitle(line.replace(/:$/, ''));
        continue;
      }
      if (opener === 'switch') { mode = 'ingredients'; continue; }
      if (INGREDIENT_LOOKING.test(cleanMarker)) mode = 'ingredients';
    }
    // A numbered line starts the steps unless it is itself a short ingredient line ("1. 600g chicken").
    if (mode === 'ingredients' && numbered && (!INGREDIENT_LOOKING.test(cleanMarker) || cleanMarker.split(' ').length > 10)) mode = 'instructions';
    // "Here's how I made it:" often introduces the whole recipe: a measured line before any step is an ingredient.
    if (mode === 'instructions' && !draft.instructions.length && !draft.ingredients.length && looksLikeMeasuredIngredient(line)) mode = 'ingredients';
    if (mode !== 'meta' && isSocialCaptionTail(line)) break;

    if (mode === 'ingredients') {
      if (endsIngredientBlock(cleanMarker)) { mode = 'done'; continue; }
      if (looksLikeSectionHeading(line)) { ingredientSection = cleanTitle(line.replace(/:$/, '')); continue; }
      const inlineSection = splitInlineSection(cleanMarker);
      if (inlineSection) { ingredientSection = cleanTitle(inlineSection.section); cleanMarker = inlineSection.rest; }
      if (cleanMarker) draft.ingredients.push(parseIngredientLine(cleanMarker, ingredientSection));
    } else if (mode === 'instructions') {
      const clean = cleanMarker;
      if (/^[A-Za-z][A-Za-z &'’-]+:$/.test(clean)) { instructionSection = clean.replace(/:$/, ''); continue; }
      if (clean) draft.instructions.push({
        id: makeId('step'), stepNumber: draft.instructions.length + 1,
        section: instructionSection, text: clean,
        timerMinutes: Number(clean.match(/\b(\d+)\s+minutes?\b/i)?.[1] ?? '') || null,
      });
    } else if (!isSocialCaptionTail(line) && !/^@\w+\b/.test(line) && !/^https?:\/\//i.test(line)) {
      descriptionLines.push(line);
    }
  }
  draft.description = descriptionLines.join(' ').slice(0, 2_000);

  const warnings: string[] = [];
  if (!draft.ingredients.length) warnings.push('No ingredient lines were confidently detected.');
  if (!draft.instructions.length) warnings.push('No instruction steps were confidently detected.');
  const reviewCount = draft.ingredients.filter((item) => item.needsReview).length;
  if (reviewCount) warnings.push(`${reviewCount} ingredient${reviewCount === 1 ? ' needs' : 's need'} a quick review.`);
  return { draft, warnings };
}

const UNQUANTIFIED_FAMILY = 'opaque:unquantified';

function measureFamily(unit: string | null): string {
  if (unit === null) return UNQUANTIFIED_FAMILY;
  return unitDefinition(unit)?.family ?? `opaque:${unit}`;
}

function toBase(value: Rational, unit: string | null): Rational {
  return multiplyRational(value, rational(unitDefinition(unit)?.factor ?? 1));
}

function fromBase(value: Rational, unit: string): Rational {
  return divideRational(value, rational(unitDefinition(unit)?.factor ?? 1));
}

/** Units a total may be promoted to even when no recipe used them. Pints, quarts, gallons, fl oz, cl and dozen appear only when a recipe measured in them. */
const PROMOTABLE_UNITS = new Set(['tsp', 'tbsp', 'cup', 'oz', 'lb', 'g', 'kg', 'ml', 'l', 'each']);
/** Measuring-cup fractions: 4 tbsp reads better as ¼ cup, but 1 tsp never becomes ⅓ tbsp. */
const CUP_FRACTIONS = new Set(['1/4', '1/3', '1/2', '2/3', '3/4']);

/** At least one, with a denominator of 4 or less, or an eighth with its own glyph (2⅛ cups beats 34 tbsp; 7/12 cup is never shown). */
function readsCleanly(value: Rational): boolean {
  return value.numerator >= value.denominator && (value.denominator <= 4 || value.denominator === 8);
}

function isCountLike(family: string): boolean {
  return family === 'count' || family.startsWith('opaque:');
}

function ceilRational(value: Rational): Rational {
  return rational(Math.ceil(value.numerator / value.denominator));
}

/**
 * The largest unit in the family that reads cleanly: 3 tsp → 1 tbsp, 4 tbsp → ¼ cup, 16 oz → 1 lb, 1000 g → 1 kg,
 * 1000 ml → 1 l; otherwise the smaller unit (6⅓ tbsp). "dozen" only when the total is a whole number of dozens and a
 * recipe counted in dozens.
 */
function bestDisplayUnit(baseValue: Rational, family: string, contributedUnits: Set<string>): { value: Rational; unit: string } {
  const candidates = UNIT_DEFINITIONS
    .filter((unit) => unit.family === family && (contributedUnits.has(unit.code) || PROMOTABLE_UNITS.has(unit.code)))
    .sort((a, b) => b.factor - a.factor);
  for (const unit of candidates) {
    const value = fromBase(baseValue, unit.code);
    if (unit.code === 'dozen') {
      if (value.denominator === 1 && contributedUnits.has('dozen')) return { value, unit: unit.code };
      continue;
    }
    if (readsCleanly(value) || (unit.code === 'cup' && CUP_FRACTIONS.has(`${value.numerator}/${value.denominator}`))) return { value, unit: unit.code };
  }
  const fallback = candidates.at(-1)?.code ?? [...contributedUnits][0] ?? 'each';
  return { value: fromBase(baseValue, fallback), unit: fallback };
}

/** FNV-1a over the row key, so regenerating the list mints the same id for the same ingredient and unit. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function scaleIngredient(ingredient: Ingredient, factor: Rational): Ingredient {
  if (!ingredient.quantity) return ingredient;
  return {
    ...ingredient,
    quantity: multiplyRational(ingredient.quantity, factor),
    quantityMax: ingredient.quantityMax ? multiplyRational(ingredient.quantityMax, factor) : ingredient.quantityMax,
  };
}

/**
 * At the recipe's own servings the author's phrasing is shown untouched (bullet removed). When scaled,
 * the line is rebuilt as "qty unit name, preparation" with pluralized units and scaled ranges.
 */
export function formatIngredient(ingredient: Ingredient, factor: Rational = rational(1)): string {
  const original = cleanLine(ingredient.rawText) || ingredient.ingredientName;
  if (factor.numerator === factor.denominator || !ingredient.quantity) return original;
  const scaled = scaleIngredient(ingredient, factor);
  const max = scaled.quantityMax ?? null;
  const amount = formatQuantityWithUnit(scaled.quantity, null, max);
  const unitText = pluralizeUnit(scaled.unit, max ?? scaled.quantity);
  // A size word describes the measure of a count-like unit ("2 large bunches kale") and the item after a measured one ("2 cups large shells").
  const head = isMeasuredUnit(scaled.unit)
    ? [amount, unitText, ingredient.descriptor]
    : [amount, ingredient.descriptor, unitText];
  const note = ingredient.note ? ` (${ingredient.note})` : '';
  const preparation = ingredient.preparation ? `, ${ingredient.preparation}` : '';
  return `${[...head, ingredient.ingredientName].filter(Boolean).join(' ')}${note}${preparation}`.replace(/\s+/g, ' ').trim();
}

type GroceryGroup = {
  names: string[]; normalized: string; groupId: string; family: string; base: Rational | null;
  units: Set<string>; category: GroceryCategory; contributions: GroceryItem['recipeContributions'];
};

/** The shortest name is the cleanest: "parsley" beats "finely chopped parsley". Casing is left as written. */
function shortestName(names: string[]): string {
  return names.reduce((best, name) => (name.trim().length && name.trim().length < best.length ? name.trim() : best), names[0] ?? '');
}

export function aggregateRecipes(
  recipes: Recipe[],
  servingsByRecipe: Record<string, number | null> = {},
  pantryStaples: string[] = [],
  occurrences: Array<{ recipeId: string; servings: number | null }> = [],
): GroceryItem[] {
  const groups = new Map<string, GroceryGroup>();
  const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const work = occurrences.length
    ? occurrences.flatMap((occurrence) => {
        const recipe = recipesById.get(occurrence.recipeId);
        return recipe ? [{ recipe, requested: occurrence.servings }] : [];
      })
    : recipes.map((recipe) => ({ recipe, requested: servingsByRecipe[recipe.id] }));
  for (const { recipe, requested } of work) {
    const factor = requested && recipe.servings ? rational(requested, recipe.servings) : rational(1);
    for (const ingredient of recipe.ingredients) {
      if (ingredient.skipGrocery) continue;
      if (matchesPantryStaple(ingredient.normalizedIngredient, pantryStaples)) continue;
      const family = measureFamily(ingredient.normalizedUnit);
      const groupId = ingredient.normalizedIngredient || `${recipe.id}:${ingredient.id}`;
      const key = `${groupId}|${family}`;
      // A range such as "2–3 cloves" shops for the upper bound so the cook is never short.
      const effective = ingredient.quantityMax ?? ingredient.quantity;
      const scaled = effective ? multiplyRational(effective, factor) : null;
      const group = groups.get(key) ?? {
        names: [], normalized: ingredient.normalizedIngredient, groupId,
        family, base: null, units: new Set<string>(), category: ingredient.groceryCategory, contributions: [],
      };
      group.names.push(ingredient.ingredientName);
      if (scaled && ingredient.normalizedUnit) {
        group.base = group.base ? addRational(group.base, toBase(scaled, ingredient.normalizedUnit)) : toBase(scaled, ingredient.normalizedUnit);
        group.units.add(ingredient.normalizedUnit);
      }
      group.contributions.push({
        recipeId: recipe.id, recipeTitle: recipe.title, ingredientId: ingredient.id,
        rawText: ingredient.rawText, quantity: scaled, unit: ingredient.normalizedUnit,
      });
      groups.set(key, group);
    }
  }

  // A contribution with no amount ("Eggs, for brushing") joins the quantified row for the same ingredient instead of
  // becoming a second row; it stands alone only when nothing quantified that ingredient. With several quantified
  // rows (parsley by the tbsp and by the bunch) it joins the one with the most contributions, the earliest on a tie.
  for (const [key, group] of [...groups]) {
    if (group.family !== UNQUANTIFIED_FAMILY) continue;
    const quantified = [...groups.values()]
      .filter((candidate) => candidate.normalized === group.normalized && candidate.family !== UNQUANTIFIED_FAMILY)
      .sort((a, b) => b.contributions.length - a.contributions.length)[0];
    if (!quantified) continue;
    quantified.names.push(...group.names);
    quantified.contributions.push(...group.contributions);
    groups.delete(key);
  }

  const mintedIds = new Set<string>();
  return [...groups.values()].map((group) => {
    const display = group.base ? bestDisplayUnit(group.base, group.family, group.units) : null;
    // Whole things are bought whole: ¾ of an onion is one onion, 2¼ cloves are 3. The exact amounts stay in the contributions.
    const quantity = display ? (isCountLike(group.family) ? ceilRational(display.value) : display.value) : null;
    const unit = display?.unit ?? null;
    // Deterministic ids: the same ingredient and unit always get the same row id, so a regenerated list updates rows
    // other devices already checked off instead of deleting and recreating them.
    const baseId = `grocery_${fnv1a(`${group.normalized || group.groupId}|${unit ?? ''}`)}`;
    let id = baseId;
    for (let suffix = 2; mintedIds.has(id); suffix += 1) id = `${baseId}_${suffix}`;
    mintedIds.add(id);
    return {
      id, ingredientName: shortestName(group.names),
      normalizedIngredient: group.normalized,
      quantity, unit,
      groceryCategory: group.category, checked: false, purchasedAt: null, manual: false,
      recipeContributions: group.contributions, revision: 1,
      dateModified: new Date().toISOString(),
    };
  }).sort((a, b) => a.groceryCategory.localeCompare(b.groceryCategory) || a.ingredientName.localeCompare(b.ingredientName));
}

export function draftToRecipe(draft: RecipeDraft, now = new Date().toISOString()): Recipe {
  return { ...draft, dateAdded: now, dateModified: now, lastCooked: null, timesCooked: 0, revision: 1, deletedAt: null };
}

export function createBlankDraft(sourceType: RecipeDraft['sourceType'] = 'manual'): RecipeDraft {
  return emptyDraft(sourceType);
}
