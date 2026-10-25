import Link from "next/link";
import BrandMark from "./BrandMark";
import Neighbourhood from "./Neighbourhood";
import styles from "@/app/auth.module.css";

export default function AuthStory({
  register = false,
}: {
  register?: boolean;
}) {
  return (
    <section className={styles.visualPanel} aria-label="Welcome to Prayaas">
      <Link className={styles.brand} href="/" aria-label="Prayaas home">
        <BrandMark />
        <span>prayaas.</span>
      </Link>
      <div className={styles.storyBody}>
        <div className={styles.heroCopy}>
          <span>A LITTLE EFFORT. A BETTER NEIGHBOURHOOD.</span>
          <h2>
            {register ? (
              <>
                Every neighbour
                <br />
                has a part to play.
              </>
            ) : (
              <>
                Good to have
                <br />
                you home.
              </>
            )}
          </h2>
          <p>
            {register
              ? "A shared space for your concerns, your ideas, and the everyday work of living better together."
              : "Your concerns, your community, and the small steps that make a difference. Pick up where you left off."}
          </p>
        </div>
        <div className={styles.storyIllustration}>
          <Neighbourhood />
        </div>
      </div>
      <div className={styles.storyFooter}>
        <span>SHARED SPACES. SHARED RESPONSIBILITY.</span>
        <span>Prayaas / Together</span>
      </div>
    </section>
  );
}
