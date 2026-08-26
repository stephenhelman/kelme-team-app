import { Hero } from "@/components/home/Hero";
import { HowItWorks } from "@/components/home/HowItWorks";
import { GetStarted } from "@/components/home/GetStarted";
import { BrandBand } from "@/components/home/BrandBand";
import { BrandVideo } from "@/components/home/BrandVideo";

export default function Home() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <GetStarted />
      <BrandBand />
      <BrandVideo />
    </>
  );
}
