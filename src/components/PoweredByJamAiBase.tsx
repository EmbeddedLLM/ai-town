import bannerBg from '../../assets/jamAIELLMWallPaper.png';
export default function PoweredByJamAiBase() {
  return (
    <a
      href="https://www.jamaibase.com/"
      target="_blank"
      className="group absolute top-0 right-0 w-64 h-64 md:block z-10 hidden shape-top-right-corner overflow-hidden "
      aria-label="Powered by Jam Ai Base"
    >
      <img
        src={bannerBg}
        className="absolute inset-0 group-hover:scale-[1.2] transition-transform"
        alt=""
      />
     </a>
  );
}
