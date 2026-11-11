/** Illustrative photos are derived from the title, never written over a source photo. */
export interface RecipePhoto {
  src: string;
  label: string;
  illustrative: boolean;
  credits: string | null;
}

type PhotoRule = { pattern: RegExp; file: string; label: string };
const stock = (pattern: RegExp, family: string, label = family): PhotoRule => ({
  pattern, file: `fallback-${family}.jpg`, label,
});

// Match the dish before its ingredients: chicken soup is soup, and salmon
// tacos are tacos. Word boundaries keep "eggplant" from becoming eggs.
export const RECIPE_PHOTO_RULES: readonly PhotoRule[] = [
  stock(/\b(?:crab|fish|salmon|tuna) cakes?\b/, 'crab-cakes', 'seafood cakes'),
  stock(/\b(?:egg|spring) rolls?\b/, 'egg-rolls', 'egg rolls'),
  stock(/\b(?:cauliflower|cabbage|mushroom|aubergine|eggplant) steaks?\b/, 'vegetables'),
  stock(/\b(?:french toast|pain perdu)\b/, 'french-toast', 'French toast'),
  stock(/\b(?:pancakes?|hotcakes?|flapjacks?|crepes?)\b/, 'pancakes'),
  stock(/\bwaffles?\b/, 'waffles'),
  stock(/\b(?:oatmeal|porridge|overnight oats|baked oats)\b/, 'oatmeal'),
  stock(/\b(?:granola|muesli|cereal)\b/, 'cereal'),
  stock(/\b(?:smoothies?|milkshakes?|shakes?|lassi)\b/, 'smoothie'),
  { pattern: /\bbanana (?:nut )?bread\b/, file: 'banana-bread.jpg', label: 'banana bread' },
  stock(/\b(?:brownies?|blondies?)\b/, 'brownies'),
  { pattern: /\b(?:cookies?|biscuits?|shortbread)\b/, file: 'fallback-cookies.png', label: 'cookies' },
  stock(/\b(?:muffins?|cupcakes?)\b/, 'muffins'),
  stock(/\b(?:cakes?|cheesecakes?|tortes?)\b/, 'cake'),
  stock(/\b(?:mousse|puddings?|custard|panna cotta)\b/, 'mousse', 'dessert'),
  stock(/\b(?:pizzas?|flatbreads?|calzones?)\b/, 'pizza'),
  stock(/\b(?:burgers?|cheeseburgers?|sliders?)\b/, 'burger'),
  stock(/\b(?:sandwich(?:es)?|panini|toasties?|grilled cheese|wraps?)\b/, 'sandwich'),
  { pattern: /\b(?:tacos?|burritos?|quesadillas?|fajitas?|enchiladas?)\b/, file: 'chicken-tacos.jpg', label: 'tacos' },
  stock(/\b(?:lasagn[ae]|baked ziti)\b/, 'lasagna'),
  stock(/\b(?:casseroles?|gratin|pot pies?|shepherds? pie|cottage pie|hotdish)\b/, 'casserole'),
  stock(/\b(?:pies?|tarts?|cobblers?|crumbles?|fruit crisps?)\b/, 'pie'),
  stock(/\b(?:dumplings?|gyoza|potstickers?|pierogi|momo)\b/, 'dumplings'),
  stock(/\b(?:chili|chilli)\b(?! (?:oil|sauce|crisp|butter|lime|garlic|chicken|shrimp|salmon|tofu|beef|pork|rubbed|peppers?))/, 'chili'),
  stock(/\b(?:stews?|bourguignon|goulash|pot roast)\b/, 'stew'),
  stock(/\b(?:curr(?:y|ies)|masala|korma|tikka|dal|dahl)\b/, 'curry'),
  { pattern: /\b(?:soups?|chowders?|bisque|gazpacho)\b/, file: 'tomato-soup.jpg', label: 'soup' },
  { pattern: /\b(?:salads?|slaw)\b/, file: 'bean-salad.jpg', label: 'salad' },
  { pattern: /\b(?:pasta|spaghetti|fettuccine|linguine|penne|rigatoni|macaroni|mac (?:and|n|&) cheese|gnocchi|ravioli|tortellini|orzo)\b/, file: 'tuscan-pasta.jpg', label: 'pasta' },
  stock(/\b(?:noodles?|ramen|udon|soba|lo mein|chow mein|pad thai|pho)\b/, 'noodles'),
  stock(/\b(?:rice|risotto|biryani|paella|pilaf|jambalaya)\b/, 'rice'),
  stock(/\bstir fr(?:y|ies)\b/, 'stir-fry', 'stir fry'),
  stock(/\b(?:omelettes?|omelets?|frittatas?|quiche|eggs?|shakshuka)\b/, 'eggs'),
  stock(/\b(?:breads?|sourdough|focaccia|bagels?|rolls?|toast)\b/, 'bread'),
  stock(/\b(?:tofu|tempeh|seitan)\b/, 'tofu'),
  stock(/\b(?:shrimps?|prawns?|scampi)\b/, 'shrimp'),
  { pattern: /\b(?:salmon|fish|cod|tilapia|trout|tuna|halibut|haddock)\b/, file: 'salmon-bowl.jpg', label: 'fish' },
  stock(/\b(?:meatballs?|kofta)\b/, 'meatballs'),
  stock(/\b(?:steaks?|beef|brisket|meatloaf|lamb)\b/, 'steak'),
  stock(/\b(?:pork|ham|ribs?|bacon|sausage)\b/, 'pork'),
  { pattern: /\b(?:chicken|turkey|duck|poultry|wings?)\b/, file: 'lemon-chicken.jpg', label: 'roast chicken' },
  stock(/\b(?:potatoes|potato|fries|hash browns?|tater tots?)\b/, 'potatoes'),
  stock(/\b(?:vegetables?|broccoli|cauliflower|carrots?|zucchini|courgette|eggplant|aubergine|squash|asparagus|cabbage|mushrooms?|brussels sprouts?|green beans?)\b/, 'vegetables'),
  { pattern: /\b(?:beans?|chickpeas?|lentils?|quinoa|bowls?)\b/, file: 'bean-salad.jpg', label: 'grain and bean salad' },
];

export function genericRecipePhoto(title: string): RecipePhoto {
  const normalized = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’']/g, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  const rule = RECIPE_PHOTO_RULES.find(({ pattern }) => pattern.test(normalized));
  const file = rule?.file ?? 'bean-salad.jpg';
  return {
    src: `./recipes/${file}`,
    label: rule?.label ?? 'meal',
    illustrative: true,
    credits: file.startsWith('fallback-') ? `./recipes/photo-credits.html#${file.slice(9, -4)}` : null,
  };
}

export function recipePhotoCandidates(title: string, heroImage: string | null | undefined): RecipePhoto[] {
  const generic = genericRecipePhoto(title);
  const photos: RecipePhoto[] = [];
  // A pending private media reference cannot be displayed until sync resolves it.
  if (heroImage && /^(?:https?:\/\/|data:image\/(?:jpeg|png|webp);base64,|\.\/recipes\/)/i.test(heroImage)) {
    photos.push({ src: heroImage, label: title, illustrative: false, credits: null });
  }
  photos.push(generic);
  photos.push({ src: './recipes/bean-salad.jpg', label: 'meal', illustrative: true, credits: null });
  return photos.filter((photo, index) => photos.findIndex((other) => other.src === photo.src) === index);
}
