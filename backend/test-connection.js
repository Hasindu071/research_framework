import dns from "dns";
import { MongoClient } from "mongodb";

console.log("🔍 MongoDB Connection Diagnostics\n");

// Test 1: DNS Resolution
console.log("1️⃣  Testing DNS Resolution...");
dns.resolveSrv("_mongodb._tcp.cluster0.xaxihjm.mongodb.net", (err, addresses) => {
  if (err) {
    console.log("   ❌ DNS SRV lookup failed:", err.code);
    console.log("   Possible causes:");
    console.log("   - No internet connection");
    console.log("   - DNS server not responding");
    console.log("   - Network/Firewall blocking DNS queries");
  } else {
    console.log("   ✓ DNS resolved successfully");
    console.log("   Addresses:", addresses);
  }

  // Test 2: Ping DNS servers
  console.log("\n2️⃣  Testing DNS servers...");
  dns.resolve4("8.8.8.8", (err) => {
    if (err) {
      console.log("   ❌ Cannot reach Google DNS (8.8.8.8)");
    } else {
      console.log("   ✓ Google DNS (8.8.8.8) is reachable");
    }

    // Test 3: Resolve MongoDB hostname
    console.log("\n3️⃣  Resolving cluster0.xaxihjm.mongodb.net...");
    dns.resolve4("cluster0.xaxihjm.mongodb.net", (err, addresses) => {
      if (err) {
        console.log("   ❌ Cannot resolve MongoDB hostname:", err.code);
      } else {
        console.log("   ✓ MongoDB hostname resolved to:", addresses);
      }

      // Test 4: Try MongoDB connection
      console.log("\n4️⃣  Testing MongoDB connection...");
      const mongoUri = "mongodb+srv://hasindu:123456Ht@cluster0.xaxihjm.mongodb.net/?appName=Cluster0";
      
      const client = new MongoClient(mongoUri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });

      client.connect()
        .then(() => {
          console.log("   ✓ MongoDB connection successful!");
          client.close();
          process.exit(0);
        })
        .catch((err) => {
          console.log("   ❌ MongoDB connection failed:", err.message);
          console.log("\n📋 Summary:");
          console.log("   Error Code:", err.code);
          console.log("   Error Details:", err);
          process.exit(1);
        });
    });
  });
});

// Timeout after 10 seconds
setTimeout(() => {
  console.log("\n⏱️  Timeout - connection test taking too long");
  process.exit(1);
}, 10000);
