import {asyncHandler} from "../utils/asyncHandler.js"
import {ApiError} from "../utils/ApiError.js"
import {User} from "../models/user.models.js"
import {uploadOnCloudinary} from "../utils/cloudinary.js"
import {ApiResponse} from "../utils/ApiResponse.js"
import { json } from "express"
import jwt from "jsonwebtoken"
import {deleteFromCloudinary} from "../utils/deleteOldFile.js"
import { mongoose } from "mongoose"

// method to generate access or refresh token
const generateBothTokens = async(userId) => {
    try{
        const user = await User.findById(userId)
        const accessToken  = user.generateAccessToken()
        const refreshToken = user.generateRefreshToken()

        user.refreshToken = refreshToken
        await user.save({validateBeforSave : false})

        return {accessToken , refreshToken}

    }catch(error){
        throw new ApiError(500 , "something went wrong while generating token")
    }
}

// capital User mongodb ka object hai jab database se nikalna ho to 
// capital use karna hai or agar apna method call karna ho jaise bcrypt wagera to
// apna banaya hua user use karna hai

const registerUser = asyncHandler( async(req , res)=>{
     
    // step 1 : get user details 
    const {fullname , email, username , password} = req.body
    //console.log("email" , email);

    // step2 : validate if all details are filled using array
    if([fullname, email,username , password].some((feild)=> 
    feild?.trim() === "")){
        throw new ApiError(400 , "All feilds are required")
    }

    // step 3: check if user already exist
    const existedUser = await User.findOne({
        $or: [ {email} , {username}]
    })
    if(existedUser){
        throw new ApiError(409 , "User with email or username exist")
    }
    
    // check for images
    const avatarLocalPath = req.files?.avatar[0]?.path;
    // const CoverImageLocalPath = req.files?.coverimage[0]?.path
    let CoverImageLocalPath;
    if(req.files && Array.isArray(req.files.coverImage)&&
req.files.coverImage.length>0){
    CoverImageLocalPath = req.files.coverImage[0].path
}
    if(!avatarLocalPath){
        throw new ApiError(400 , "Avatar file is required")
    }

    // upload on cloudinary
    const avatar = await uploadOnCloudinary(avatarLocalPath)
    const coverimage = await uploadOnCloudinary(CoverImageLocalPath)
    if(!avatar){
        throw new ApiError(400 , "Avatar file is required")
    }

    // crete user and make entry in database

    const user = await User.create({
        fullname,
        avatar: avatar.url,
        coverimage: coverimage?.url || "",
        email,
        password,
        username: username.toLowerCase()
    })

    // check for user creation and remove password and refresh token feild
    const createdUser = await User.findById(user._id).select(
        "-password -refreshToken"
    )
    if(!createdUser){
        throw new ApiError(500 , "Something went wrong while registering user")
    }

    // return response

    return res.status(201).json(
        new ApiResponse(200, createdUser, "User registered successfully")
    )

} )

const loginUser = asyncHandler(async (req,res)=>{
    // req body se data lana hai
    // username or email se login lena hai
    const { email, username, password } = req.body

    if (!username && !email) {
        throw new ApiError(400, "Either username or email is required");
    }

    // find the user based on any of email or username
    const user = await User.findOne({
        $or: [{username}, {email}]
    })
    if(!user){
        throw new ApiError(404, "user does not exist")
    }

    // check password
    
    const isPassValid = await user.isPasswordCorrect(password)
    if(!isPassValid){
        throw new ApiError(404, "password incorrect")
    }
    // access and refresh token send to user

   const {accessToken , refreshToken} = await generateBothTokens(user._id)


    // send cookie

    const loggedInUser = await User.findById(user._id).
    select("-password -refreshToken")
    

    const options = {
        httpOnly : true,
        secure: true
    }
    return res.
    status(200).
    cookie("accessToken", accessToken , options )
    .cookie("refreshToken" , refreshToken , options)
    .json(
        new ApiResponse(
            200,
            {
                user: loggedInUser , accessToken, refreshToken
            }
            
            ,"User logged In successfully"
        )
    )
})

const loggedOutUser = asyncHandler( async(req,res) =>{
    // remove cookies from server and reset access token
    // but here we can not access user from database because we don't want
    // user to imput anything for log out
    // to deal with this we use custom middleware 

    await User.findByIdAndUpdate(
        req.user._id,
        {
            $set: {
                refreshToken : undefined
            }  // ye operation value set karne ke kaam me aata hai
        },
        {
            new: true
        }
    )
    const options = {
        httpOnly : true,
        secure: true
    }
    return res
    .status(200)
    .clearCookie("accessToken" , options)
    .clearCookie("refreshToken" , options)
    .json(new ApiResponse(200 , {} ,"user logged out" ))
})

// use of access token and refresh token 

// if access token is expired because it is short lived,
// user can restart the session by using refresh token , 
// which is short lived and present in database
// for this restarting of session frontend should hit an 
// endpoint where we can refresh out access token 
// by validating with the help of refresh token
// check endpoint in user.router as refresh-token


const refreshAccessToken = asyncHandler(async (req,res) =>{
    const incomingRefreshToken = req.cookies.refreshToken ||
    req.body.refreshToken

    if(!incomingRefreshToken){
        throw new ApiError(401 , "unathorized request")
    }
    try {
        const decodedToken = jwt.verify(
            incomingRefreshToken , process.env.REFRESH_TOKEN_SECRET
        )
        const user = await User.findById(decodedToken._id)
        if(!user){
            throw new ApiError(401 , "invalid refresh token")
        }
        if(incomingRefreshToken!= user?.refreshToken){
            throw new ApiError(401 , "Refresh token is expired or used")
        }
        const options = {
            httpOnly : true,
            secure : true
        }
        const {accessToken, newRefreshToken} =  await generateBothTokens(user._id)
        return res
        .status(200)
        .cookie("accessToken",accessToken, options)
        .cookie("refreshToken",newRefreshToken ,options)
        .json(
            new ApiResponse(
                200,
                {accessToken , newRefreshToken},
                "Access token refreshed"
            )
        )
    } catch (error) {
       throw new ApiError(400 , error?.message || "invalid refresh token") 
    }
})

const changeCurrentPassword = asyncHandler(async(req,res)=>{
    const {oldPassword , newPassword} = req.body
    const user = await User.findById(req.user?._id)
    const isPasswordCorrect = await user.isPasswordCorrect(oldPassword)

    if(!isPasswordCorrect){
        throw new ApiError(400 , "Invalid old Password")
    }
    user.password = newPassword
    await user.save({validateBeforSave: false})

    return res
    .status(200)
    .json(new ApiResponse(200 , {} , "password change successful"))
})

const getCurrentUser = asyncHandler(async(req,res)=>{
    return res
    .status(200)
    .json(200, req.user , "current user fetched successfully")
})
const updateAccountdetails = asyncHandler(async(req,res) =>{
    const {fullname , email} = req.body
    if(!fullname || !email){
        throw new ApiError(400 , "All feilds are required")
    }
    const user =  await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set:{
                fullname,
                email
            }
        },
        {new:true}
    ).select("-password")
    return res.status(200)
    .json(new ApiResponse(200 , user , "user updated successfully"))
})
// use 2 middle wares while routing , one to check user login and another of multer
const updateAvatar = asyncHandler(async(req,res)=>{
    const avatarLocalPath = req.file?.path
    if(!avatarLocalPath){
        throw new ApiError(400, "avatar file is missing")
    }
    const avatar = await uploadOnCloudinary(avatarLocalPath)
    if(!avatar){
        throw new ApiError(400, "error while uploading on cloudinary")
    }
    const user = await User.findById(req.user._id);
    if (user?.avatar) {
        await deleteFromCloudinary(user.avatar); // Delete old avatar from Cloudinary
    }
    const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        { 
            $set: { 
                avatar: avatar.url
            } 
        },
        { new: true }
    ).lean(); // Converts Mongoose doc to plain JS object
    
    if (updatedUser?.secure) {
        updatedUser = updatedUser.secure("-password"); // Only if `secure()` is available
    }
    return res.status(200)
    .json(new ApiResponse(200 , updatedUser , "avatar updated successfully"))
})
const updateCoverImage = asyncHandler(async(req,res)=>{
    const coverImageLocalPath = req.file?.path
    if(!coverImageLocalPath){
        throw new ApiError(400, "cover Image file is missing")
    }
    const coverimage = await uploadOnCloudinary(coverImageLocalPath)
    if(!coverimage){
        throw new ApiError(400, "error while uploading on cloudinary")
    }

    const user = await User.findByIdAndUpdate(
        req.user._id,
        {
            $set:{
                coverimage: coverimage.url
            }
        },
        {new:true}
    ).lean()
    if (user?.secure) {
        user = user.secure("-password"); // Only if `secure()` is available
    }
    return res.status(200)
    .json(new ApiResponse(200 , user , "cover image updated successfully"))
})

// AGGREGATION PIPELINE FOR SUBSCRIBERS

// aggregation pipeline is generally used for joining two or more
// schemas below pipeline is used for joining user schema to subscribers
// injecting subscribers , subscribedTo and isFollow elements to 
// each user profile 

const getUserChannelProfile = asyncHandler(async(req,res)=>{

    // get the username from req.params
    const {username} = req.params
    if(!username?.trim){
        throw new ApiError(400, "user does not exist")
    }
    
    const channel = await User.aggregate([
        // match the username to one in database
        {
            $match : {
                username : username?.toLowerCase()
            }
        },
        // get all  documents of specific channels as subscribers 
        // use lookUp for this
        {
            $lookup:{
                from : "subscriptions",
                localField : "_id",
                foreignField: "channel",
                as: "subscribers"
            }
        },
        // get all  documents of specific subscribers as subscribedTo
        // use lookUp for this
        {
            $lookup:{
                from : "subscriptions",
                localField : "_id",
                foreignField: "subscriber",
                as: "subscribedTo"
            }
        },
        // count number of subscribers, subscribedTo and isSubscribed
        {
            $addFields:{
                subscribersCount :{
                    $size: "$subscribers"
                },
                channelSubscribedToCount:{
                    $size : "$subscribedTo"
                },
                isSubscribed: {
                    $cond :{
                        if: {$in : [req.user?._id , "$subscribers.subscribers"]},
                        then:true,
                        else : false
                    }
                }
            }
        },
        // to make new document containing all necessary details
        // to show on channel page
        {
            $project : {
                fullname : 1,
                username : 1,
                subscribersCount:1,
                channelSubscribedToCount :1,
                isSubscribed:1,
                avatar : 1,
                coverimage : 1,
                email : 1,
            }
        }
    ])
    if(!channel?.length){
        throw new ApiError(404 , "channel does not exist")
    }
    return res.status(200)
    .json(
        new ApiResponse(200, channel[0] , "user channel fetched successfully")
    )
})

// AGGREGATION PIPELINE FOR WATCH HISTORY
const getWatchHistiry = asyncHandler(async(req,res)=>{
    // req.user._id // here we get string object('id') but mongoose convert it to only id
    const user = await User.aggregate([
        {
            $match:{
               // _id: req.user._id this will not work we have to explicitly change it 
               _id : new mongoose.Types.ObjectId(req.user._id)

            }
        },
        {
            $lookup: {
                from : "videos",
                localField: "watchHistory",
                foreignField : "_id",
                as: "watchHistory",

                // here we have got our vedio but we also want owner
                // so we use subpipeline to get owner also
                pipeline : [
                    {
                        $lookup:{
                            from : "users",
                            localField : "owner",
                            foreignField : "_id",
                            as : "owner",
                            pipeline : [
                                {
                                    $project:{
                                        fullname: 1,
                                        username:1,
                                        avatar:1
                                    }
                                }
                            ]
                        }
                    },
                    {
                        $addFields:{
                            owner:{
                                $first : "$owner"
                            }
                        }
                    }
                ]
            }

        }
    ])

    return res.status(200)
    .json(
        new ApiResponse(
            200,
            user[0].watchHistory,
            "watch history fetched"
        )
    )
})

export {registerUser}
export{loginUser}
export{loggedOutUser}
export{refreshAccessToken}
export{changeCurrentPassword}
export{getCurrentUser}
export{updateAccountdetails}
export{updateAvatar}
export{updateCoverImage}
export{getUserChannelProfile}
export{getWatchHistiry}

