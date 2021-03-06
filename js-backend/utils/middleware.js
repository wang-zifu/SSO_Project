const crypto = require("crypto");

const JWTHandler = require("./jwt.js").JWTHandler;
const UserLib = require("./user.js").User;

// This class is prone to circular dependancies (if part of utils) and missing context (https://stackoverflow.com/q/45643005/1424378) - beware
class MiddlewareHelper {
	constructor(db) {
		this.ownJwtToken = process.env.UNIQUEJWTTOKEN;
		this.hostname = process.env.DOMAIN || "localhost";
		this.frontendPort = process.env.FRONTENDPORT || 8080;
		
		this.db = db;
		this.User = new UserLib(db);
		this.JWT = new JWTHandler();
	}
	
	// Protection against timing attacks
	antiTiming(req, res, next) {
		crypto.randomBytes(4, function(ex, buf) {
			var hex = buf.toString("hex");
			var randInt = parseInt(hex, 16);

			setTimeout(() => {
				next();
			}, randInt % 1500);
		});
	}

	// Middleware for Authorization header
	parseAuthHeader(req, res, next) {
		if(!req || !req.headers || !req.headers.authorization) return next();
		const authHeader = req.headers.authorization;
		if(authHeader.indexOf(" ") == -1) return next();
		
		const headerParts = authHeader.split(" ");
		if(headerParts[0] != "Bearer") return next();
		
		this.checkAuthToken(headerParts[1]).then(authentication => {
			if(authentication.hasOwnProperty("token") && Number.isInteger(authentication.sub)) {
				req.user = authentication;
			}
			next();
		}).catch(() => {
			next();
		});
	}

	checkAuthToken(token) {
		return this.JWT.verify(token, this.ownJwtToken, {
			maxAge: this.JWT.age().SHORT,
		});
	}

	// Is the user just logged in (first factor)?
	isLoggedIn(req, res, next) {
		if(req.user && req.user.id) {
			next();
		} else {
			res.status(403).send("You need to be signed in");
		}
	}

	// Is the user device authenticated (via 2FA)?
	isAuthenticated(req, res, next) {
		if(!req.user) return res.status(403).send("User not logged in");
		if(!req.user.token) return res.status(403).send("Authorization token missing");
		
		this.User.validateSession(req.user.token).then(session => {
			if(req.user.id == session.userId) {
				next();
			} else {
				this.User.deleteSession(req.user.token).then(() => {
					res.status(400).send("Token mismatch");
				});
			}
		}).catch(err => {
			res.status(400).send(err);
		});
	}

	showSuccess(req, res) {
		return res.status(200).send("success");
	}

	createLoginToken(req, res, next) {
		const email = req.loginEmail;
		
		this.User.findUserByName(email).then(user => {
			return this.JWT.sign({
				sub: user.id,
				id: user.id,
				username: email,
			}, this.ownJwtToken, this.JWT.age().MEDIUM);
		}).then(jwtData => {
			let returnObj = {
				"token": jwtData,
				"username": email,
				"factor": 1,
			};
			if(req.returnExtra) {
				returnObj = Object.assign(returnObj, req.returnExtra);
			}
			
			return res.status(200).json(returnObj);
		}).catch(err => {
			console.error(err);
			res.status(400).send(err.message);
		});
	}

	createAuthToken(req, res, next) {
		if(!req.user.id) {
			return res.status(403).send("User needs to be logged in to finish authentication");
		}
		
		let publicAttributes;
		Promise.all([
			this.User.createSession(req.user.id),
			this.User.findUserById(req.user.id),
		]).then(values => {
			const {password, last_login, created, ...publicAttributesTmp} = values[1];
			publicAttributes = publicAttributesTmp;
			publicAttributes.sub = req.user.id;
			publicAttributes.token = values[0];
			publicAttributes.authenticators.forEach(v => {
				delete v.userCounter;
				delete v.userKey;
			});
			
			return this.JWT.sign(publicAttributes, this.ownJwtToken, this.JWT.age().LONG);
		}).then(jwtData => {
			let returnObj = {
				"token": jwtData,
				"username": publicAttributes.username,
				"factor": 2,
			};
			if(req.returnExtra) {
				returnObj = Object.assign(returnObj, req.returnExtra);
			}
			
			if(req.body.authorizationToken) {
				res.status(200).send("<script>const authData = JSON.parse('" +JSON.stringify(returnObj)+ "'); window.parent.postMessage(authData, 'https://" + this.hostname + ":" + this.frontendPort + "');</script>");
			} else {
				res.status(200).json(returnObj);
			}
		}).catch(err => {
			console.error(err);
			return res.status(400).send(err.message);
		});
	}
}

exports.MiddlewareHelper = MiddlewareHelper;