export interface Category {
  label: string;
  /** Text used in the Places text search. */
  query: string;
}

export const CATEGORIES: Category[] = [
  { label: "Car Detailing", query: "car detailing" },
  { label: "Mobile Car Detailing", query: "mobile car detailing" },
  { label: "Hair Salons", query: "hair salon" },
  { label: "Nail Salons", query: "nail salon" },
  { label: "Barbershops", query: "barbershop" },
  { label: "Dental Clinics", query: "dental clinic" },
  { label: "Restaurants", query: "restaurant" },
  { label: "Mobile Accessories Stores", query: "cell phone accessories store" },
  { label: "Auto Repair Shops", query: "auto repair shop" },
  { label: "Plumbers", query: "plumber" },
  { label: "Electricians", query: "electrician" },
  { label: "Landscaping", query: "landscaping company" },
  { label: "Cleaning Services", query: "cleaning service" },
  { label: "Roofing Contractors", query: "roofing contractor" },
  { label: "Chiropractors", query: "chiropractor" },
  { label: "Gyms & Fitness Studios", query: "gym fitness studio" },
  { label: "Pet Grooming", query: "pet grooming" },
  { label: "Spas & Massage", query: "day spa massage" },
  { label: "Tattoo Studios", query: "tattoo studio" },
  { label: "Bakeries & Cafes", query: "bakery cafe" },
];

/** Resolve the search text for a category label (custom labels are used as-is). */
export function categoryQuery(label: string): string {
  const hit = CATEGORIES.find((c) => c.label.toLowerCase() === label.trim().toLowerCase());
  return hit ? hit.query : label.trim();
}
