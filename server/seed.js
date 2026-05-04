const { Pool } = require("pg");

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "auth",
  password: "Daniyal@2004",
  port: 5432,
});

async function seedDatabase() {
  console.log("🌱 Generating 50 dummy employees...");

  for (let i = 1; i <= 50; i++) {
    // Generate 128 random numbers between -1 and 1
    const randomVector = Array.from({ length: 128 }, () => (Math.random() * 2 - 1).toFixed(6));
    const vectorStr = `[${randomVector.join(",")}]`;
    const dummyName = `Dummy Employee ${i}`;

    const query = "INSERT INTO emp (name, embedding) VALUES ($1, $2)";
    await pool.query(query, [dummyName, vectorStr]);
    
    if (i % 10 === 0) console.log(`✅ Added ${i} employees...`);
  }

  console.log("🎉 Successfully added 50 dummy employees to the database!");
  pool.end();
}

seedDatabase().catch((err) => {
  console.error("❌ Error seeding database:", err);
  pool.end();
});
