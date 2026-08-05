import adjectives, {
  adjectivesLength,
} from "@/utils/slug/dictionaries/adjectives";
import colors, { colorsLength } from "@/utils/slug/dictionaries/colors";

import animals, { animalsLength } from "@/utils/slug/dictionaries/animals";

export default function generateSlug() {
  const joinAdjective = [...adjectives, ...colors];
  const joinAdjectiveLength = adjectivesLength + colorsLength;

  const randomAdjectiveIndex = Math.floor(Math.random() * joinAdjectiveLength);
  const randomAnimalIndex = Math.floor(Math.random() * animalsLength);
  const randomNumber = Math.floor(Math.random() * 10_000);
  const numberString = randomNumber.toString().padStart(4, "0");

  return `${joinAdjective[randomAdjectiveIndex]}-${animals[randomAnimalIndex]}-${numberString}`;
}
