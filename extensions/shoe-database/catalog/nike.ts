import type { Shoe } from "../types.js";

export const NIKE: Shoe[] = [
  // ── PEGASUS LINE ─────────────────────────────────────────────────────────────

  {
    id: "nike-pegasus",
    brand: "Nike",
    model: "Air Zoom Pegasus",
    category: "neutral",
    cushion: "moderate",
    variants: [
      {
        version: "40",
        year: 2023,
        spec: { heelStack: 30, forefootStack: 20, drop: 10, weightGrams: 281, msrp: 130 },
        foam: "ReactX + dual Air Zoom units",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["dual Air Zoom units (heel + forefoot)", "ReactX foam base", "10mm drop"],
        useCases: ["daily-trainer", "long-run", "tempo"],
        notes: "Nike's iconic daily trainer. Dual Air Zoom units add forefoot snap. Lower stack (30mm) gives more ground feel than maximalist competitors.",
      },
      {
        version: "41",
        year: 2024,
        spec: { heelStack: 30, forefootStack: 20, drop: 10, weightGrams: 278, msrp: 140 },
        foam: "ReactX + dual Air Zoom units",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["updated engineered mesh", "improved heel collar", "3g lighter than Peg 40"],
        useCases: ["daily-trainer", "long-run", "tempo"],
        notes: "iRunFar 'Best Overall Nike Road Running Shoe 2025'. Approachable, versatile, reliable. Lower stack gives more ground feedback vs HOKA/NB competitors.",
      },
      {
        version: "42",
        year: 2026,
        spec: { heelStack: 37, forefootStack: 27, drop: 10, weightGrams: 284, msrp: 140 },
        foam: "ReactX + full-length curved Air Zoom unit",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["full-length curved Air Zoom unit (plate-like propulsion)", "new anatomical last (more toe room)", "+7mm heel stack vs Peg 41", "same ReactX foam"],
        useCases: ["daily-trainer", "long-run", "tempo"],
        notes: "Major change: full-length curved Air Zoom replaces dual units. +7mm heel stack. New wider last improves fit. Forbes 'Best Overall Nike Running Shoe 2026'. Slightly heavier than Peg 41.",
      },
    ],
  },

  {
    id: "nike-pegasus-plus",
    brand: "Nike",
    model: "Pegasus Plus",
    category: "neutral",
    cushion: "high",
    variants: [
      {
        version: "1",
        year: 2025,
        spec: { heelStack: 40, forefootStack: 32, drop: 8, weightGrams: 255, msrp: 180 },
        foam: "ZoomX",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["full ZoomX midsole", "8mm drop", "Pegasus-inspired upper", "plush daily trainer"],
        useCases: ["daily-trainer", "long-run"],
        notes: "ZoomX-equipped Pegasus sub-line. More premium foam than Pegasus 41/42. Good for runners wanting ZoomX feel in a daily trainer without a plate.",
      },
    ],
  },

  {
    id: "nike-pegasus-premium",
    brand: "Nike",
    model: "Pegasus Premium",
    category: "neutral",
    cushion: "high",
    variants: [
      {
        version: "1",
        year: 2025,
        spec: { heelStack: 42, forefootStack: 34, drop: 8, weightGrams: 262, msrp: 220 },
        foam: "ZoomX + ReactX",
        plate: { present: true, material: "air", description: "Air Zoom plate layer" },
        surfaces: ["road"],
        rocker: true,
        features: ["ZoomX top + ReactX base", "Air plate for propulsion", "8mm drop", "plated max-cushion training"],
        useCases: ["tempo", "long-run", "daily-trainer"],
        notes: "Plated Pegasus sub-line with premium dual foam. Air plate provides structured energy return. Good for runners wanting a plated training option without full carbon price.",
      },
    ],
  },

  // ── VOMERO LINE ───────────────────────────────────────────────────────────────

  {
    id: "nike-vomero",
    brand: "Nike",
    model: "Vomero",
    category: "neutral",
    cushion: "max",
    variants: [
      {
        version: "17",
        year: 2023,
        spec: { heelStack: 39, forefootStack: 31, drop: 8, weightGrams: 305, msrp: 180 },
        foam: "ZoomX + ReactX",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["ZoomX top + ReactX base dual foam", "8mm drop", "wide platform"],
        useCases: ["daily-trainer", "long-run", "recovery"],
        notes: "Nike's max-cushion daily trainer. ZoomX for softness, ReactX for durability. 8mm drop.",
      },
      {
        version: "18",
        year: 2024,
        spec: { heelStack: 40, forefootStack: 32, drop: 8, weightGrams: 299, msrp: 175, refSize: "men's US 9" },
        genderVariants: {
          mens:   { weightGrams: 299, refSize: "men's US 9" },
          womens: { weightGrams: 252, refSize: "women's US 8" },  // ~8.9oz
        },
        foam: "ZoomX + ReactX",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["6g lighter than Vomero 17", "improved upper", "+1mm stack", "competitive price for ZoomX+ReactX"],
        useCases: ["daily-trainer", "long-run", "recovery"],
        notes: "Run Testers 'Best Training Shoe in the Nike Range'. RunDNA 'Excellent easy/long run daily trainer'. Great value for dual-foam ZoomX tech. Women's: ~8.9oz/252g.",
      },
    ],
  },

  {
    id: "nike-vomero-plus",
    brand: "Nike",
    model: "Vomero Plus",
    category: "neutral",
    cushion: "max",
    variants: [
      {
        version: "1",
        year: 2025,
        spec: { heelStack: 43, forefootStack: 35, drop: 8, weightGrams: 298, msrp: 210 },
        foam: "ZoomX + ReactX",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["higher stack than Vomero 18", "premium ZoomX+ReactX", "wider platform", "Run Testers 'best cushioned running shoe from any brand'"],
        useCases: ["daily-trainer", "long-run", "recovery"],
        notes: "Run Testers 'Favourite Training Shoe Nike Range and Perhaps Best Cushioned Running Shoe from Any Brand'. Forbes 'Best for Long-Distance Runs'. Premium max-cushion trainer.",
      },
    ],
  },

  {
    id: "nike-vomero-premium",
    brand: "Nike",
    model: "Vomero Premium",
    category: "neutral",
    cushion: "max",
    variants: [
      {
        version: "1",
        year: 2025,
        spec: { heelStack: 44, forefootStack: 36, drop: 8, weightGrams: 305, msrp: 250 },
        foam: "ZoomX + ReactX",
        plate: { present: true, material: "air", description: "Air plate" },
        surfaces: ["road"],
        rocker: true,
        features: ["Air plate for propulsion", "ZoomX+ReactX dual foam", "highest stack in Vomero line", "8mm drop"],
        useCases: ["daily-trainer", "long-run", "tempo"],
        notes: "Plated max-cushion trainer. Air plate adds structure and propulsion. Premium tier of the Vomero line.",
      },
    ],
  },

  // ── STRUCTURE LINE ────────────────────────────────────────────────────────────

  {
    id: "nike-structure",
    brand: "Nike",
    model: "Structure",
    category: "stability",
    cushion: "moderate",
    variants: [
      {
        version: "25",
        year: 2024,
        spec: { heelStack: 34, forefootStack: 24, drop: 10, weightGrams: 289, msrp: 130 },
        foam: "ReactX",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["Progressive Diagonal Rollbar stability post", "ReactX foam", "10mm drop"],
        useCases: ["daily-trainer", "long-run"],
        notes: "Nike's flagship stability trainer. Progressive Diagonal Rollbar is Nike's medial post approach. Reliable mild-to-moderate overpronation control.",
      },
      {
        version: "Plus",
        year: 2026,
        spec: { heelStack: 36, forefootStack: 26, drop: 10, weightGrams: 285, msrp: 150 },
        foam: "ReactX",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["updated stability system", "+2mm stack", "updated upper", "Forbes 'Best Stability Nike 2026'"],
        useCases: ["daily-trainer", "long-run"],
        notes: "Forbes 'Best Nike Running Shoes for Stability'. Updated stack and upper from Structure 25. Nike's main stability option.",
      },
    ],
  },

  // ── RACE SHOES ────────────────────────────────────────────────────────────────

  {
    id: "nike-vaporfly",
    brand: "Nike",
    model: "Vaporfly",
    category: "neutral",
    cushion: "high",
    variants: [
      {
        version: "3",
        year: 2023,
        spec: { heelStack: 40, forefootStack: 32, drop: 8, weightGrams: 195, msrp: 260 },
        foam: "ZoomX (PEBA)",
        plate: { present: true, material: "carbon", description: "full-length carbon fiber plate" },
        surfaces: ["road"],
        rocker: true,
        features: ["full-length carbon fiber plate", "ZoomX PEBA foam", "racing geometry"],
        useCases: ["race", "tempo"],
        notes: "Elite marathon racer. ZoomX + carbon delivers class-leading energy return. Competes with Adios Pro and MetaSpeed Sky.",
      },
      {
        version: "4",
        year: 2025,
        spec: { heelStack: 40, forefootStack: 32, drop: 8, weightGrams: 188, msrp: 260 },
        foam: "ZoomX (PEBA, updated)",
        plate: { present: true, material: "carbon", description: "full-length carbon fiber plate" },
        surfaces: ["road"],
        rocker: true,
        features: ["7g lighter than Vaporfly 3", "updated plate angle", "Flyknit upper"],
        useCases: ["race", "tempo"],
        notes: "7g lighter than Vaporfly 3. Updated plate geometry. Highly competitive top-tier marathon racer.",
      },
    ],
  },

  {
    id: "nike-alphafly",
    brand: "Nike",
    model: "Alphafly",
    category: "neutral",
    cushion: "max",
    variants: [
      {
        version: "3",
        year: 2024,
        spec: { heelStack: 45, forefootStack: 37, drop: 8, weightGrams: 199, msrp: 285 },
        foam: "ZoomX (PEBA)",
        plate: { present: true, material: "carbon", description: "full-length carbon plate + Air pods" },
        surfaces: ["road"],
        rocker: true,
        features: ["ZoomX + Air Zoom pods", "full-length carbon plate", "maximum stack marathon racer", "Atomknit upper"],
        useCases: ["race"],
        notes: "Nike's max-cushion marathon weapon. Air Zoom pods under ZoomX foam deliver peak energy return. Worn by marathon world record holders.",
      },
    ],
  },
];
