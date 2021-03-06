const validator = require("validator");
const url = require("url");
const { Audit, User, JWT } = require("../utils");

const samlp = require("samlp");
const PassportProfileMapper = require(require.resolve("samlp/lib/claims/PassportProfileMapper.js"));
PassportProfileMapper.prototype.getClaims = function() {
	// Default one requires firstname & lastname, which we can not provide
	return claims = {
		"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": this._pu.id,
		"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": this._pu.displayName,
		"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name": this._pu.displayName,
	};
};

class ssoFlow {
	constructor(customPages, fido2Options, serverCrt, serverKey) {
		this.ownJwtToken = process.env.UNIQUEJWTTOKEN;
		this.customPages = customPages;
		this.fido2Options = fido2Options;
		this.serverCrt = serverCrt;
		this.serverKey = serverKey;
		this.hostname = process.env.DOMAIN || "localhost";
	}

	// Flow to be redone - cant do redirects etc, but should instead just offer data about specific page IDs, which are managed by the client
	// Then for the flow out, the client just requests an "outgoing" token for a page
	// Test eg via http://jwtbuilder.jamiekurtz.com/
	async onFlowIn(req, res, next) {
		const dataIn = req.query.d || req.body.d;
		const pageId = req.query.id || req.body.id;
		if(!pageId || isNaN(pageId)) {
			return res.status(400).send("Invalid flow request - missing parameters");
		} else if(!this.customPages.hasOwnProperty(pageId)) {
			return res.status(404).send("Website ID not found");
		}
		
		const thisPage = this.customPages[pageId];
		let jwtInput;
		
		if(!dataIn && thisPage.signedRequestsOnly) {
			return res.status(403).send("This website is configured to only allow signed login requests");
		}
		if(dataIn) {
			try {
				jwtInput = JWT.verify(dataIn, thisPage.jwt, {
					maxAge: JWT.age().SHORT,
					issuer: thisPage.name,
				});
			} catch(err) {
				//console.error(err)
				return res.status(403).send(err.name + ": " + err.message);
			}
		}
		//console.log("jwtInput", jwtInput)
		
		const jwtObj = {
			pageId,
			jwt: true,
		};
		if(jwtInput && jwtInput.hasOwnProperty("sub")) {
			jwtObj.sub = jwtInput.sub;
		}
		JWT.sign(jwtObj, this.ownJwtToken, JWT.age().MEDIUM).then(jwtData => {
			req.returnExtra = {
				page: {
					pageId,
					name: thisPage.name,
					branding: thisPage.branding,
					token: jwtData,
					flowType: "jwt",
				},
			};
			
			if(jwtInput && jwtInput.hasOwnProperty("sub")) {
				if(!validator.isEmail(jwtInput.sub+"")) {
					return res.status(400).send("Subject is not a valid email address");
				}
				
				const email = jwtInput.sub;
				req.returnExtra.page.username = email;
				User.findUserByName(email).then(userData => {
					req.loginEmail = email;
					req.user = userData;
					return Audit.add(req, "page", "request", thisPage.name);
				}).then(() => {
					// Artificially log in as this user
					createLoginToken(req, res, next);
				}).catch(err => {
					console.error(err);
					
					// User does not exist - register
					User.addUser(email, null).then(userId => {
						return User.findUserById(userId);
					}).then(userData => {
						req.loginEmail = email;
						req.user = userData;
						
						return Audit.add(req, "page", "registration", thisPage.name);
					}).then(() => {
						createLoginToken(req, res, next);
					}).catch(err => {
						console.error(err);
						res.status(500).send("Creating user automatically failed");
					});
				});
			} else {
				res.status(200).json(req.returnExtra);
			}
		}).catch(err => {
			res.status(500).send("Signing failed");
		});
	}

	onFlowOut(req, res, next) {
		const jwtRequest = req.ssoRequest;
		const pageId = jwtRequest.pageId;
		const thisPage = this.customPages[pageId];
		
		if(jwtRequest.hasOwnProperty("sub")) {
			if(req.user.username.toLowerCase() != jwtRequest.sub.toLowerCase()) {
				return res.status(403).send("The website needs you to be explicitly signed into the account it requested");
			}
		}

		if(!jwtRequest && !jwtRequest.hasOwnProperty("saml")) {
			return res.status(400).send("Invalid session JWT");
		}
		
		Audit.add(req, "page", "login", thisPage.name).then(() => {
			if(jwtRequest.jwt) {
				JWT.sign({
					sub: req.user.username,
					aud: thisPage.name,
				}, thisPage.jwt, JWT.age().SHORT).then(jwtData => {
					Audit.add(req, "page", "login", thisPage.name).then(() => {
						const returnObj = {
							redirect: thisPage.redirect,
							token: jwtData,
						};
						
						res.status(200).json(returnObj);
					});
				});
			} else if(jwtRequest.hasOwnProperty("saml")) {
				req.query.SAMLRequest = jwtRequest.saml.request;
				req.query.RelayState = jwtRequest.saml.relay;
				
				samlp.parseRequest(req, (err, samlData) => {
					samlp.auth({
						issuer: this.fido2Options.rpName,
						cert: this.serverCrt,
						key: this.serverKey,
						getPostURL: (audience, ream, req, callback) => {
							return callback(null, samlData.destination);
						},
						getUserFromRequest: (req) => {
							return {
								id: req.user.id,
								displayName: req.user.username,
							};
						},
						responseHandler: (response, opts, req, res, next) => {
							const returnObj = {
								SAMLResponse: response.toString("base64"),
								RelayState: req.query.RelayState,
								redirect: samlData.destination,
							};
							
							res.status(200).json(returnObj);
						},
						profileMapper: PassportProfileMapper,
					})(req, res, next);
				});
			}
		});
	}

	// SAML
	// Test flow: https://samltest.id/start-idp-test/
	// Test payload: https://localhost:8080/#/in/saml?SAMLRequest=fZJbc6owFIX%2FCpN3EAEVMmIHEfDaqlCP%2BtKJELkUEkqCl%2F76Uj3O9JyHPmay9l4r%2BVb%2F6VLkwglXLKXEBG1JBgImIY1SEpvgNXBFHTwN%2BgwVeQmtmidkjT9qzLjQzBEGbxcmqCsCKWIpgwQVmEEeQt9azKEiybCsKKchzYFgMYYr3hjZlLC6wJWPq1Ma4tf13AQJ5yWDrVZO45RIDOWYHWkVYimkBRBGjWVKEL%2BlfEhDSjhlVEJNLvlb1%2FqOA4TJyARvynPH80qFFJPAdg%2Fh1fNnGVqpKO3OLkZonUfJ0Nu2Y2t6PdlVPj1RZxVlThywI8rihVH0MuksTQz3sx1Fm2xv5LO9nYSs5KXxfnm364%2FwfMDPWMqn182qHOqpjzR0dncsM6xO1Vs7h860HI97yrB7xHE9dt2loy%2FQu1prie%2FMcuNNL2i6nUdWp%2Fdnk3yekb7dXYhWjFjil%2Br2IC%2Bd%2FexlNF7wS77Zomvo7epFbCuyVx5tq3klYzWeEMYR4SZQ5LYqypqo6IGiQE2FmiKpencPhOXf%2Fx%2Bm5E71N1iHu4jBcRAsxeWLHwBh82hHIwD3LsCbefWjBL%2BvRQ%2FyYPCAd4MmRvgk4kgqrv8R77d%2B2Azup38LOPgC&RelayState=123
	// Create own: https://www.samltool.com/sign_authn.php
	onSamlIn(req, res, next) {
		samlp.parseRequest(req, (err, samlData) => {
			if(this.hostname == "localhost") {
				samlData.destination = this.customPages["1"].redirect;
			}
			
			if(err) {
				console.error(err);
				return res.status(400).send("Invalid SAML request");
			}
			
			if(!samlData.destination) {
				return res.status(400).send("Destination parameter missing");
			}
			
			const issUrl = url.parse(samlData.destination);
			let pageId = false;
			for (let thisPageId of Object.keys(this.customPages)) {
				const thisPage = this.customPages[thisPageId];
				// Question for the future - what happens if two pages have the same hostname? Eg one company wants to have two pages redirect to the same destination.
				// I don't see a good way to identify the source website more uniquely in SAML standard requests
				// The ID would be possible but appears to be used for other purposes
				if(url.parse(thisPage.redirect).hostname == issUrl.hostname) {
					pageId = thisPageId;
					break;
				}
			}
			if(!pageId) {
				return res.status(404).send("No website matches to the requested destination host");
			}
			const thisPage = this.customPages[pageId];
			
			const jwtObj = {
				pageId,
				saml: {
					request: req.query.SAMLRequest,
					relay: req.query.RelayState,
				},
			};
			JWT.sign(jwtObj, this.ownJwtToken, JWT.age().SHORT).then(jwtData => {
				res.status(200).json({
					page: {
						pageId,
						name: thisPage.name,
						branding: thisPage.branding,
						token: jwtData,
						flowType: "saml",
					},
				});
			});
		});
	}

	onSamlMeta(req, res, next) {
		samlp.metadata({
			issuer: this.fido2Options.rpName,
			cert: this.serverCrt,
			profileMapper: PassportProfileMapper,
		});
	}

	// Middleware for SSO Token
	parseSSOHeader(req, res, next) {
		if(!req || !req.headers || !req.headers["x-sso-token"]) return next();
		const ssoToken = req.headers["x-sso-token"];
		
		JWT.verify(ssoToken, this.ownJwtToken, {
			maxAge: JWT.age().MEDIUM,
		}).then(jwtRequest => {
			if(!jwtRequest.pageId) return next();
			req.ssoRequest = jwtRequest;
			next();
		}).catch(err => {
			next();
		});
	}
}

exports.ssoFlow = ssoFlow;