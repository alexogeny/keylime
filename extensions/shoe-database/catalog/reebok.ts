import type { Shoe } from "../types.js";

export const REEBOK: Shoe[] = [
  {
    id: "reebok-floatzig-1",
    brand: "Reebok",
    model: "FloatZig 1",
    category: "neutral",
    cushion: "moderate",
    variants: [
      {
        version: "1",
        year: 2024,
        spec: { heelStack: 31, forefootStack: 25, drop: 6, weightGrams: 277, msrp: 130, refSize: "men's US 9" },
        genderVariants: {
          mens:   { weightGrams: 277, refSize: "men's US 9" },
          womens: { weightGrams: 247, refSize: "women's US 8" },
        },
        foam: "FloatZig (beaded TPE — thermoplastic elastomer)",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: [
          "zigzag-shaped midsole geometry for energy transfer",
          "beaded TPE foam (same family as adidas Boost)",
          "6mm drop",
          "retro-1990s colorways",
          "$130 accessible price",
        ],
        useCases: ["daily-trainer", "long-run"],
        notes:
          "Reebok's return to form in running. Zigzag midsole channels energy through the foam. Beaded TPE (FloatZig foam) delivers solid energy return at a budget price point. Outside Run: 'light, cushy, responsive at a good price'. RunRepeat and Switchback Travel included in 2026 best-of guides. Women's: 8.7oz / 247g.",
      },
    ],
  },

  {
    id: "reebok-floatride-energy",
    brand: "Reebok",
    model: "Floatride Energy",
    category: "neutral",
    cushion: "moderate",
    variants: [
      {
        version: "5",
        year: 2023,
        spec: { heelStack: 35, forefootStack: 28, drop: 7, weightGrams: 264, msrp: 100 },
        foam: "Floatride Energy Foam (beaded TPE)",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["beaded TPE foam", "7mm drop", "budget price", "lightweight"],
        useCases: ["daily-trainer", "tempo"],
        notes: "Reebok's budget workhorse. Beaded TPE Floatride Energy Foam punches above its price point. Consistently well-regarded as a quality budget daily trainer.",
      },
      {
        version: "6",
        year: 2025,
        spec: { heelStack: 37.5, forefootStack: 34.5, drop: 3, weightGrams: 260, msrp: 110 },
        foam: "Floatride Energy Foam (beaded TPE, updated)",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["ultra-low 3mm drop", "+2.5mm heel / +6.5mm forefoot stack vs Floatride 5", "minimal heel-to-toe offset"],
        useCases: ["daily-trainer", "tempo"],
        notes: "Significant spec change from v5: 3mm drop is unusually low for a daily trainer. Stack increased considerably. For runners who want a low-drop feel with more cushion than typical minimalist shoes.",
      },
    ],
  },

  {
    id: "reebok-floatzig-symmetros",
    brand: "Reebok",
    model: "FloatZig Symmetros",
    category: "stability",
    cushion: "moderate",
    variants: [
      {
        version: "1",
        year: 2024,
        spec: { heelStack: 31, forefootStack: 25, drop: 6, weightGrams: 285, msrp: 140 },
        foam: "FloatZig (beaded TPE)",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["stability version of FloatZig 1", "medial post", "6mm drop", "wider base"],
        useCases: ["daily-trainer", "long-run"],
        notes: "Stability companion to the FloatZig 1. Same FloatZig beaded TPE foam with medial stability guidance. For mild-to-moderate overpronators wanting Reebok's foam at a budget price.",
      },
    ],
  },
];
