import express from 'express';
import userModel from '../models/user.js';
import tokenModel from '../models/token.js';
import twoFactor from '../internal/2fa.js';
import internalToken from '../internal/token.js';
import { createRouter } from './router.mjs';
export default createRouter({ express, getUser: id => userModel.query().findById(id), tokenModel, twoFactor, internalToken });
