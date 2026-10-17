// GENERATED from the website's taxonomy (src/lib/taxonomy.ts,
// src/lib/search/dishes.ts FOOD_CATEGORIES). Regenerate rather than hand-edit,
// so a chip here never advertises a category the web's search can't answer.
// ignore_for_file: lines_longer_than_80_chars

class FoodCategory {
  const FoodCategory(this.id, this.label, this.keywords, this.cuisines);
  final String id;
  final String label;
  final List<String> keywords;
  final List<String> cuisines;
}

class CategoryTile {
  const CategoryTile(this.id, this.label, this.emoji, this.image, this.tint);
  final String id;
  final String label;
  final String emoji;
  final String? image;
  final String? tint;
}

class StoreCategory {
  const StoreCategory(this.id, this.label, this.emoji, this.image, this.tags);
  final String id;
  final String label;
  final String emoji;
  final String? image;
  final List<String> tags;
}

const foodCategories = <FoodCategory>[
  FoodCategory('thali', 'Thali', ['thali', 'meal', 'meals', 'full meal', 'veg thali', 'special thali', 'unlimited', 'plate', 'bhojan'], ['North Indian', 'South Indian', 'Chhattisgarhi']),
  FoodCategory('biryani', 'Biryani', ['biryani', 'biriyani', 'dum', 'pulao', 'pulav'], ['Biryani', 'North Indian']),
  FoodCategory('momos', 'Momos', ['momo', 'momos', 'dumpling', 'dimsum', 'dim sum', 'steam momo', 'fried momo', 'tandoori momo', 'pan fried'], ['Chinese', 'Tibetan', 'Street Food']),
  FoodCategory('snacks', 'Samosa & Chaat', ['samosa', 'kachori', 'chaat', 'chat', 'pakoda', 'pakora', 'bhajiya', 'tikki', 'aloo tikki', 'golgappa', 'panipuri', 'pani puri', 'puchka', 'bhel', 'sev puri', 'dahi puri', 'vada pav', 'bara', 'chila', 'cheela', 'fara', 'namkeen'], ['Street Food', 'Chaat', 'Snacks', 'Chhattisgarhi']),
  FoodCategory('pizza', 'Pizza', ['pizza', 'margherita', 'calzone', 'garlic bread'], ['Italian']),
  FoodCategory('burgers', 'Burgers', ['burger', 'fries', 'sandwich', 'nuggets'], ['Fast Food']),
  FoodCategory('rolls', 'Rolls', ['roll', 'kathi', 'frankie', 'wrap', 'shawarma'], ['Fast Food']),
  FoodCategory('chinese', 'Chinese', ['noodle', 'noodles', 'hakka', 'manchurian', 'momo', 'fried rice', 'schezwan', 'chowmein', 'spring roll'], ['Chinese']),
  FoodCategory('south', 'South Indian', ['dosa', 'idli', 'vada', 'uttapam', 'sambar', 'upma', 'appam'], ['South Indian']),
  FoodCategory('paratha', 'Paratha & Roti', ['paratha', 'parantha', 'roti', 'naan', 'kulcha', 'chapati', 'bhatura', 'bhature', 'chole bhature', 'tandoori roti', 'rumali', 'puri', 'poori', 'litti'], ['North Indian']),
  FoodCategory('chicken', 'Chicken & Tandoori', ['chicken', 'murg', 'tandoori', 'tikka', 'kebab', 'kabab', 'seekh', 'butter chicken', 'chilli chicken', 'leg piece', 'mutton', 'keema'], ['North Indian', 'Mughlai']),
  FoodCategory('egg', 'Egg', ['egg', 'anda', 'bhurji', 'omelette', 'omelet', 'half fry', 'boiled egg', 'egg curry', 'egg roll', 'double egg'], []),
  FoodCategory('healthy', 'Healthy', ['salad', 'bowl', 'smoothie', 'grill', 'soup', 'sprout', 'quinoa'], ['Healthy']),
  FoodCategory('desserts', 'Sweets', ['sweets', 'dessert', 'mithai', 'gulab', 'jamun', 'rasgulla', 'rasmalai', 'jalebi', 'imarti', 'laddu', 'ladoo', 'barfi', 'burfi', 'peda', 'rabri', 'halwa', 'kaju katli', 'sondesh', 'balushahi', 'cake', 'pastry', 'brownie', 'dessert'], ['Desserts', 'Sweets']),
  FoodCategory('icecream', 'Ice Cream', ['ice cream', 'icecream', 'kulfi', 'falooda', 'sundae', 'cone', 'scoop', 'gelato', 'thick shake', 'thickshake'], ['Desserts']),
  FoodCategory('beverages', 'Drinks', ['coffee', 'tea', 'chai', 'lassi', 'shake', 'juice', 'mojito', 'soda', 'cola', 'beverage', 'drink', 'chaas', 'buttermilk', 'thandai', 'nimbu', 'shikanji', 'sharbat', 'sugarcane', 'ganne'], ['Beverages']),
];

/// The Home strip, in display order.
const homeCategories = <CategoryTile>[
  CategoryTile('thali', 'Thali', '🍛', 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=200&h=200&q=70&auto=format&fit=crop', 'linear-gradient(135deg,#f6c453,#e8552d)'),
  CategoryTile('biryani', 'Biryani', '🍚', 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=200&h=200&q=70&auto=format&fit=crop', 'linear-gradient(135deg,#f2a65a,#c2410c)'),
  CategoryTile('chinese', 'Chinese', '🥡', 'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=200&h=200&q=70&auto=format&fit=crop', 'linear-gradient(135deg,#f87171,#991b1b)'),
  CategoryTile('momos', 'Momos', '🥟', 'https://images.unsplash.com/photo-1496116218417-1a781b1c416c?w=200&h=200&q=70&auto=format&fit=crop', 'linear-gradient(135deg,#e5e7eb,#9ca3af)'),
  CategoryTile('snacks', 'Samosa & Chaat', '🥠', 'https://images.unsplash.com/photo-1601050690117-94f5f6fa8bd7?w=200&h=200&q=70&auto=format&fit=crop', 'linear-gradient(135deg,#fbbf24,#b45309)'),
  CategoryTile('south', 'South Indian', '🥞', 'https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=200&h=200&q=70&auto=format&fit=crop', 'linear-gradient(135deg,#fde68a,#d97706)'),
  CategoryTile('rolls', 'Rolls', '🌯', 'https://images.unsplash.com/photo-1541014741259-de529411b96a?w=200&h=200&q=70&auto=format&fit=crop', 'linear-gradient(135deg,#fca5a5,#b91c1c)'),
  CategoryTile('paratha', 'Paratha & Roti', '🫓', 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=200&h=200&q=70&auto=format&fit=crop', 'linear-gradient(135deg,#fcd34d,#92400e)'),
  CategoryTile('chicken', 'Chicken & Tandoori', '🍗', 'https://images.unsplash.com/photo-1610057099443-fde8c4d50f91?w=200&h=200&q=70&auto=format&fit=crop', 'linear-gradient(135deg,#f97316,#7c2d12)'),
  CategoryTile('egg', 'Egg', '🥚', 'https://images.unsplash.com/photo-1482049016688-2d3e1b311543?w=200&h=200&q=70&auto=format&fit=crop', 'linear-gradient(135deg,#fef3c7,#f59e0b)'),
  CategoryTile('pizza', 'Pizza', '🍕', 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=200&h=200&q=70&auto=format&fit=crop', 'linear-gradient(135deg,#fb923c,#b91c1c)'),
  CategoryTile('burgers', 'Burgers', '🍔', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=200&h=200&q=70&auto=format&fit=crop', 'linear-gradient(135deg,#fbbf24,#78350f)'),
  CategoryTile('desserts', 'Sweets', '🍮', 'https://images.unsplash.com/photo-1551024506-0bccd828d307?w=200&h=200&q=70&auto=format&fit=crop', 'linear-gradient(135deg,#f9a8d4,#be185d)'),
  CategoryTile('icecream', 'Ice Cream', '🍨', 'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=200&h=200&q=70&auto=format&fit=crop', 'linear-gradient(135deg,#bfdbfe,#6366f1)'),
  CategoryTile('beverages', 'Drinks', '🥤', 'https://images.unsplash.com/photo-1544145945-f90425340c7e?w=200&h=200&q=70&auto=format&fit=crop', 'linear-gradient(135deg,#86efac,#047857)'),
];

const storeCategories = <StoreCategory>[
  StoreCategory('bakery', 'Bakery', '🥐', 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=200&h=200&q=70&auto=format&fit=crop', ['Bakery', 'Desserts']),
  StoreCategory('dairy', 'Dairy', '🥛', 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=200&h=200&q=70&auto=format&fit=crop', ['Dairy']),
  StoreCategory('groceries', 'Groceries', '🛒', 'https://images.unsplash.com/photo-1542838132-92c53300491e?w=200&h=200&q=70&auto=format&fit=crop', ['Groceries', 'Kirana']),
  StoreCategory('pick-drop', 'Pick & Drop', '🛵', 'https://images.unsplash.com/photo-1558981806-ec527fa84c39?w=200&h=200&q=70&auto=format&fit=crop', ['Pick & Drop']),
  StoreCategory('raw-meat', 'Raw Meat', '🍗', 'https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?w=200&h=200&q=70&auto=format&fit=crop', ['Raw Meat', 'Meat', 'Fish']),
  StoreCategory('chowpaty', 'Chowpaty', '🍧', 'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=200&h=200&q=70&auto=format&fit=crop', ['Chowpaty', 'Street Food', 'Chaat']),
];
