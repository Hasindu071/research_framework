# MongoDB Integration Guide

## Overview

The backend now integrates with MongoDB to automatically save all analysis results and test execution data to a cloud database. Results are organized by repository name into separate collections within the `research` database.

## Prerequisites

1. MongoDB Atlas account (free tier available)
2. Connection string with credentials
3. Database name: `research` (automatically used)

## Configuration

### Environment Variables

Update your `.env` file with MongoDB credentials:

```env
# MongoDB Configuration
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/?appName=Cluster0
MONGODB_DB_NAME=research
```

Replace with your actual MongoDB Atlas credentials.

## Usage

### Updated Endpoints

All API endpoints now accept a `repoName` parameter (required) which determines the MongoDB collection name where results are saved.

#### 1. Analyze Commit
```bash
POST /api/analyze-commit
Content-Type: application/json

{
  "repositoryPath": "/path/to/repo",
  "commitHash": "abc123def456",
  "repoName": "my-awesome-project"
}
```

**Response includes:**
- `mongoId`: Document ID in MongoDB
- `success`: Operation status
- All analysis results

---

#### 2. Analyze, Prioritize & Generate Tests
```bash
POST /api/analyze-prioritize-generate
Content-Type: application/json

{
  "repositoryPath": "/path/to/repo",
  "commitHash": "abc123def456",
  "repoName": "my-awesome-project"
}
```

**Saves to MongoDB:** Complete analysis with:
- Commit information
- File changes
- Test prioritization results
- Generated tests
- Test execution results

---

#### 3. Analyze and Run Tests
```bash
POST /api/analyze-and-run
Content-Type: application/json

{
  "repositoryPath": "/path/to/repo",
  "commitHash": "abc123def456",
  "repoName": "my-awesome-project"
}
```

---

#### 4. Run Generated Tests
```bash
POST /api/run-generated-tests
Content-Type: application/json

{
  "repositoryPath": "/path/to/repo",
  "generatedTests": [
    {
      "testFile": "path/to/test.ts",
      "testCode": "...",
      "testName": "should do something"
    }
  ],
  "repoName": "my-awesome-project"
}
```

---

### Query Saved Data

#### Get All Repositories
```bash
GET /api/repositories
```

**Response:**
```json
{
  "success": true,
  "repositories": ["my-awesome-project", "another-repo"],
  "count": 2
}
```

---

#### Get Analysis History for a Repository
```bash
GET /api/repositories/my-awesome-project
```

**Response:**
```json
{
  "success": true,
  "repoName": "my-awesome-project",
  "count": 5,
  "results": [
    {
      "_id": "507f1f77bcf86cd799439011",
      "savedAt": "2025-01-15T10:30:00.000Z",
      "savedAtTimestamp": 1705316400000,
      "commit": {
        "hash": "abc123",
        "message": "Fix bug in auth",
        "author": "john@example.com",
        "date": "2025-01-15"
      },
      "analysis": {
        "filesChanged": 3,
        "totalInsertions": 45,
        "totalDeletions": 12
      }
    }
  ]
}
```

---

## MongoDB Structure

### Database Name
`research`

### Collections
Collections are created dynamically based on `repoName`. For example:
- `my-awesome-project`
- `api-backend`
- `mobile-app`

### Document Structure

Each document contains:
```json
{
  "_id": "ObjectId",
  "savedAt": "2025-01-15T10:30:00.000Z",
  "savedAtTimestamp": 1705316400000,
  "success": true,
  "commit": {
    "hash": "abc123def456",
    "message": "Commit message",
    "author": "author@email.com",
    "date": "2025-01-15"
  },
  "analysis": {
    "filesChanged": 5,
    "totalInsertions": 120,
    "totalDeletions": 45,
    "changedSymbols": [...],
    "dependencyChanges": [...]
  },
  "prioritization": {
    "candidateTests": 15,
    "prioritizedTests": [...]
  },
  "gapAnalysis": {
    "results": [...],
    "summary": {...}
  },
  "generation": {
    "results": [...],
    "summary": {...}
  },
  "existingTestExecution": {
    "results": [...],
    "summary": {...}
  },
  "generatedTestExecution": {
    "results": [...],
    "summary": {...}
  }
}
```

## Postman Setup

### Add repoName to Requests

Modify your Postman requests to include `repoName`:

1. **Analyze Commit Request:**
   ```json
   {
     "repositoryPath": "C:\\path\\to\\repository",
     "commitHash": "1a2b3c4d",
     "repoName": "my-project"
   }
   ```

2. **Query Results:**
   - GET `/api/repositories` - List all repos
   - GET `/api/repositories/my-project` - View project history

### View in MongoDB Atlas

1. Go to MongoDB Atlas dashboard
2. Select database: `research`
3. Browse collections matching your `repoName` values
4. View documents saved from each analysis run

## Benefits

✅ **Persistent Storage** - Analysis results survive server restarts  
✅ **Historical Tracking** - View analysis history per repository  
✅ **Data Queries** - Query results using MongoDB tools  
✅ **Automatic Timestamping** - `savedAt` and `savedAtTimestamp` added automatically  
✅ **Error Handling** - Graceful handling if MongoDB is unavailable  

## Error Handling

If MongoDB connection fails, the API will:
1. Log the error to console
2. Include `mongoError` in the response
3. Still return analysis results (response not blocked)

Example error response:
```json
{
  "success": true,
  "mongoError": "Connection refused",
  "commit": {...},
  "analysis": {...}
}
```

## Troubleshooting

### MongoDB Connection Issues

**Error:** `MONGODB_URI environment variable is not set`
- **Solution:** Add `MONGODB_URI` to `.env` file

**Error:** `authentication failed`
- **Solution:** Verify username/password in connection string
- **Solution:** Check MongoDB Atlas IP whitelist includes your server

**Error:** `timeout exceeded`
- **Solution:** Check network connectivity
- **Solution:** Verify MongoDB Atlas cluster is running

### Verify Setup

1. Run health check:
   ```bash
   curl http://localhost:5000/api/health
   ```

2. List repositories:
   ```bash
   curl http://localhost:5000/api/repositories
   ```

3. Check server logs for MongoDB connection messages

## Next Steps

- Monitor analysis results in MongoDB Atlas
- Create indexes for frequently queried fields
- Set up data retention policies
- Export analysis data for further processing
