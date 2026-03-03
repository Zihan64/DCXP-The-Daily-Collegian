require("dotenv").config();
const express = require("express");
const app = express();

const twitterRouter = require("./twitter");
app.use("/api/twitter", twitterRouter);

app.listen(3000, () => console.log("Server running on port 3000"));
