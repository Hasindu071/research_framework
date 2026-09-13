import { MongoClient, Db, Collection } from "mongodb";
import dns from "dns";

// Set up DNS to use public resolvers that support SRV lookups
dns.setServers(["8.8.8.8", "8.8.4.4"]);

let mongoClient: MongoClient | null = null;
let db: Db | null = null;

/**
 * Connect to MongoDB
 */
export async function connectMongoDB(): Promise<Db> {
  if (db) {
    return db;
  }

  const mongoUri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME || "research";

  if (!mongoUri) {
    throw new Error("MONGODB_URI environment variable is not set");
  }

  try {
    mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();
    db = mongoClient.db(dbName);
    console.log(`✓ Connected to MongoDB database: ${dbName}`);
    return db;
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    throw error;
  }
}

/**
 * Disconnect from MongoDB
 */
export async function disconnectMongoDB(): Promise<void> {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
    db = null;
    console.log("✓ Disconnected from MongoDB");
  }
}

/**
 * Get the MongoDB database instance
 */
export function getDB(): Db {
  if (!db) {
    throw new Error("MongoDB is not connected. Call connectMongoDB() first.");
  }
  return db;
}

/**
 * Save analysis result to MongoDB collection
 * @param repoName The repository name (collection name)
 * @param data The data to save
 * @returns The inserted document ID
 */
export async function saveAnalysisResult(
  repoName: string,
  data: any
): Promise<string> {
  try {
    const db = getDB();
    const collection = db.collection(repoName);

    // Add metadata
    const documentWithMetadata = {
      ...data,
      savedAt: new Date(),
      savedAtTimestamp: Date.now(),
    };

    const result = await collection.insertOne(documentWithMetadata);
    console.log(
      `✓ Analysis result saved to collection '${repoName}' with ID: ${result.insertedId}`
    );
    return result.insertedId.toString();
  } catch (error) {
    console.error(`Failed to save analysis result to collection '${repoName}':`, error);
    throw error;
  }
}

/**
 * Get all analysis results for a repository
 * @param repoName The repository name (collection name)
 * @returns Array of documents
 */
export async function getAnalysisResults(repoName: string): Promise<any[]> {
  try {
    const db = getDB();
    const collection = db.collection(repoName);
    const results = await collection.find({}).toArray();
    return results;
  } catch (error) {
    console.error(
      `Failed to retrieve analysis results from collection '${repoName}':`,
      error
    );
    throw error;
  }
}

/**
 * Get the latest analysis result for a repository
 * @param repoName The repository name (collection name)
 * @returns The latest document or null
 */
export async function getLatestAnalysisResult(repoName: string): Promise<any | null> {
  try {
    const db = getDB();
    const collection = db.collection(repoName);
    const result = await collection.findOne({}, { sort: { savedAt: -1 } });
    return result;
  } catch (error) {
    console.error(
      `Failed to retrieve latest analysis result from collection '${repoName}':`,
      error
    );
    throw error;
  }
}

/**
 * List all collections (repositories) in the database
 * @returns Array of collection names
 */
export async function listRepositories(): Promise<string[]> {
  try {
    const db = getDB();
    const collections = await db.listCollections().toArray();
    return collections.map((c) => c.name);
  } catch (error) {
    console.error("Failed to list repositories:", error);
    throw error;
  }
}
